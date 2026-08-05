//! HTTP + WebSocket surface. §04's API table is normative: these six endpoints
//! are the entire server. Refs, links, tasks, tags, search and templates are all
//! client-side derivations of plain text — the sixth endpoint, `/api/reveal`,
//! exists only because opening a file manager is something a browser cannot do
//! for itself (§08 P5).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use rust_embed::Embed;
use tokio::net::TcpListener;
use tokio::sync::broadcast;

use crate::vault::{self, Vault};
use crate::watch::Event;

/// The built UI. rust-embed reads from disk in debug and embeds in release, so
/// `pnpm dev` hot-reloads while a shipped binary is self-contained.
/// `allow_missing` keeps `cargo build` green in CI, which builds the server
/// without building the frontend first.
#[derive(Embed)]
#[folder = "app/dist"]
#[allow_missing = true]
struct Assets;

/// Upper bound on a single note. Generous — a note is prose, and the vault is
/// local — but bounded, so a runaway client cannot ask the server to buffer
/// unbounded bytes.
const MAX_NOTE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    vault: Arc<Vault>,
    events: broadcast::Sender<Event>,
    /// Whether the server is bound to a loopback interface. Gates `/api/reveal`,
    /// which is the one endpoint that starts a process.
    local: bool,
}

impl AppState {
    pub fn new(vault: Arc<Vault>, events: broadcast::Sender<Event>) -> Self {
        Self {
            vault,
            events,
            local: true,
        }
    }

    /// Record what the listener actually bound to.
    pub fn bound_to(mut self, addr: SocketAddr) -> Self {
        self.local = addr.ip().is_loopback();
        self
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/tree", get(tree))
        .route(
            // axum 0.8 wildcard syntax. The 0.7 spelling (`*path`) panics at
            // construction rather than failing to compile, so `routes_build`
            // in the tests below exists purely to catch that.
            "/api/note/{*path}",
            get(read_note).put(write_note).delete(delete_note),
        )
        .route("/api/events", any(events))
        .route("/api/reveal", post(reveal))
        .fallback(asset)
        // Chosen deliberately. axum's default is 2 MiB, sized for web forms;
        // §04 puts no cap on a note, and a 2 MiB limit would reject a large
        // note with an unexplained 413 that nothing in the codebase decided on.
        .layer(DefaultBodyLimit::max(MAX_NOTE_BYTES))
        .layer(middleware::from_fn(same_origin_only))
        .with_state(state)
}

pub async fn listener(host: &str, port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind((host, port)).await
}

pub async fn serve(listener: TcpListener, state: AppState) -> std::io::Result<()> {
    axum::serve(listener, router(state)).await
}

// ------------------------------------------------------------------- handlers

async fn tree(State(state): State<AppState>) -> Response {
    let vault = state.vault.clone();
    match blocking(move || vault.tree()).await {
        Ok(tree) => Json(tree).into_response(),
        Err(response) => response,
    }
}

async fn read_note(State(state): State<AppState>, Path(path): Path<String>) -> Response {
    let vault = state.vault.clone();
    match blocking(move || vault.read(&path)).await {
        Ok((body, etag)) => (
            StatusCode::OK,
            [
                (header::ETAG, quoted(&etag)),
                (
                    header::CONTENT_TYPE,
                    "text/markdown; charset=utf-8".to_owned(),
                ),
            ],
            body,
        )
            .into_response(),
        Err(response) => response,
    }
}

async fn write_note(
    State(state): State<AppState>,
    Path(path): Path<String>,
    headers: HeaderMap,
    // Body extractors consume the request and must come last.
    body: String,
) -> Response {
    let if_match = headers
        .get(header::IF_MATCH)
        .and_then(|value| value.to_str().ok())
        .map(unquoted);

    let vault = state.vault.clone();
    match blocking(move || vault.write(&path, &body, if_match.as_deref())).await {
        Ok(etag) => (StatusCode::OK, [(header::ETAG, quoted(&etag))], "").into_response(),
        Err(response) => response,
    }
}

async fn delete_note(State(state): State<AppState>, Path(path): Path<String>) -> Response {
    let vault = state.vault.clone();
    match blocking(move || vault.trash(&path)).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(response) => response,
    }
}

/// Open the vault in the OS file manager (§08 P5).
///
/// The one endpoint that starts a process, so it is deliberately the narrowest
/// thing that satisfies the requirement: it takes **no parameters**. The path is
/// always the vault root the server was launched with, so there is nothing a
/// caller can influence and nothing to sanitise — no argument reaches a shell.
///
/// It is also refused unless the listener bound to loopback. The Origin and Host
/// guards already keep a browser out, but a `--host 0.0.0.0` deployment (P12)
/// would put a process-spawning endpoint on the network, and a forged `Host`
/// header is cheap. Binding is not forgeable.
async fn reveal(State(state): State<AppState>) -> Response {
    if !state.local {
        return (
            StatusCode::FORBIDDEN,
            "reveal is refused unless the server is bound to loopback\n",
        )
            .into_response();
    }

    let root = state.vault.root().to_path_buf();
    let opened = tokio::task::spawn_blocking(move || open_in_file_manager(&root)).await;

    match opened {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => {
            eprintln!("reveal: {error}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not open the vault\n",
            )
                .into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "reveal task failed\n").into_response(),
    }
}

fn open_in_file_manager(path: &std::path::Path) -> std::io::Result<()> {
    // No shell anywhere: the path is passed as a single argv entry, so spaces
    // and metacharacters in a vault name cannot become syntax.
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program).arg(path).spawn()?;
    Ok(())
}

async fn events(upgrade: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let events = state.events.subscribe();
    upgrade.on_upgrade(move |socket| pump(socket, events))
}

/// Forward coalesced vault events to one client until either side hangs up.
async fn pump(mut socket: WebSocket, mut events: broadcast::Receiver<Event>) {
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                _ => {}
            },
            event = events.recv() => match event {
                Ok(event) => {
                    let Ok(frame) = serde_json::to_string(&event) else { continue };
                    if socket.send(Message::Text(frame.into())).await.is_err() {
                        return;
                    }
                }
                // The client fell behind and events were dropped. §04's frame
                // schema has no way to say "there is a gap", and continuing
                // would leave the client silently, permanently wrong about the
                // vault. Hanging up is the honest signal: it reconnects and
                // re-fetches /api/tree.
                Err(broadcast::error::RecvError::Lagged(dropped)) => {
                    eprintln!("events: client lagged, {dropped} dropped; closing");
                    return;
                }
                Err(broadcast::error::RecvError::Closed) => return,
            },
        }
    }
}

async fn asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    // An unmatched /api/* is a routing mistake, never a page. Answering it with
    // the SPA shell would turn a 404 into a silently successful HTML response.
    if path == "api" || path.starts_with("api/") {
        return (StatusCode::NOT_FOUND, "no such endpoint\n").into_response();
    }

    let wanted = if path.is_empty() { "index.html" } else { path };
    match Assets::get(wanted).or_else(|| Assets::get("index.html")) {
        Some(file) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, file.metadata.mimetype().to_owned())],
            file.data.into_owned(),
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            "no UI bundled; run `cd app && pnpm build`\n",
        )
            .into_response(),
    }
}

// ----------------------------------------------------------------- middleware

/// CORS locked to same origin (P2).
///
/// The server never emits `Access-Control-Allow-Origin`, so a browser will not
/// hand our responses to a cross-origin page. That alone does not stop the
/// request from *executing*, though, and this server writes files — so a request
/// that declares a foreign origin is refused outright rather than merely having
/// its response withheld.
///
/// Loopback origins are allowed rather than one exact origin because `pnpm dev`
/// serves the UI from vite on another port and proxies `/api` here, so the
/// browser sends `Origin: http://localhost:5173`.
async fn same_origin_only(request: Request, next: Next) -> Result<Response, Response> {
    // DNS rebinding closes the gap the Origin check alone leaves open. A hostile
    // page on a domain that has been rebound to 127.0.0.1 is same-origin by the
    // browser's own reckoning, so it sends NO Origin header at all and the check
    // below never fires. The Host header names the domain the browser actually
    // dialled, so it has to be loopback too.
    let addressed_to_loopback = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(is_loopback_host);
    if !addressed_to_loopback {
        return Err((
            StatusCode::FORBIDDEN,
            "request must be addressed to loopback\n",
        )
            .into_response());
    }

    let foreign = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| !is_loopback(origin));
    if foreign {
        return Err((StatusCode::FORBIDDEN, "cross-origin request refused\n").into_response());
    }

    Ok(next.run(request).await)
}

/// The host part of an `authority`, dropping any port and IPv6 brackets.
fn host_of(authority: &str) -> &str {
    match authority.strip_prefix('[') {
        // IPv6 literal: [::1]:7777
        Some(v6) => v6.split_once(']').map(|(host, _)| host).unwrap_or_default(),
        None => authority.split(':').next().unwrap_or_default(),
    }
}

fn is_loopback_host(authority: &str) -> bool {
    let host = host_of(authority);
    // Parsed, not prefix-matched: `127.0.0.1.evil.example` starts with "127."
    // and is a perfectly ordinary attacker-controlled hostname.
    host == "localhost"
        || host == "::1"
        || host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| ip.is_loopback())
}

fn is_loopback(origin: &str) -> bool {
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    if scheme != "http" && scheme != "https" {
        return false;
    }
    is_loopback_host(rest)
}

// --------------------------------------------------------------------- shared

/// Run a blocking vault operation off the async runtime.
async fn blocking<T, F>(work: F) -> Result<T, Response>
where
    F: FnOnce() -> vault::Result<T> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(error_response(error)),
        Err(_) => Err((StatusCode::INTERNAL_SERVER_ERROR, "vault task failed\n").into_response()),
    }
}

fn error_response(error: vault::Error) -> Response {
    match error {
        vault::Error::InvalidPath => {
            (StatusCode::BAD_REQUEST, "path is outside the vault\n").into_response()
        }
        vault::Error::NotFound => (StatusCode::NOT_FOUND, "no such note\n").into_response(),
        // §04: a stale etag is a 409, and the client writes *.conflict-<ts>.md.
        // The current etag rides along so it needs no second request.
        vault::Error::Conflict { current } => (
            StatusCode::CONFLICT,
            [(header::ETAG, quoted(&current))],
            "etag is stale\n",
        )
            .into_response(),
        vault::Error::Io(error) => {
            eprintln!("vault: {error}");
            (StatusCode::INTERNAL_SERVER_ERROR, "vault io failed\n").into_response()
        }
    }
}

fn quoted(etag: &str) -> String {
    format!("\"{etag}\"")
}

fn unquoted(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("W/")
        .trim_matches('"')
        .to_owned()
}

/// Convenience for `main`: the address actually bound.
pub fn local_addr(listener: &TcpListener) -> std::io::Result<SocketAddr> {
    listener.local_addr()
}

#[cfg(test)]
mod tests;
