//! HTTP + WebSocket surface. §04's API table is normative: these six endpoints
//! are the entire server. Refs, links, tasks, tags, search and templates are all
//! client-side derivations of plain text — the sixth endpoint, `/api/reveal`,
//! exists only because opening a file manager is something a browser cannot do
//! for itself (§08 P5).

use std::net::SocketAddr;
use std::path::{Component, Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post};
use rust_embed::Embed;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio::time::timeout;

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
/// Carries remote mode's token into the WebSocket, which can send no headers.
const TOKEN_COOKIE: &str = "register_token";

const MAX_NOTE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    vault: Arc<Vault>,
    events: broadcast::Sender<Event>,
    /// Whether the server is bound to a loopback interface. Gates `/api/reveal`,
    /// which is the one endpoint that starts a process.
    local: bool,
    /// Remote mode's shared secret (§08 P12), or `None` when there is none —
    /// which is the default, and the only state a local `register serve` has.
    token: Option<String>,
    /// Serve the UI from this directory instead of the copy embedded at build
    /// time. A development affordance: the binary carries the UI, so without it
    /// every CSS change needs a full `cargo install --path . --force` before it
    /// can be seen, and a stale binary looks exactly like a broken fix.
    assets: Option<PathBuf>,
    /// How often an idle WebSocket is pinged. Named rather than constant for
    /// `Checkpointer::with_idle`'s reason: a test should not have to wait half a
    /// minute to find out whether this works.
    ping: Duration,
    /// One extra origin the guard will accept, for `pnpm dev`.
    ///
    /// Empty in every shipped configuration. The guard used to accept *any*
    /// loopback origin so vite could proxy from another port — which handed the
    /// same authority to every other web server on the machine, so a page on
    /// `http://localhost:3000` could read, write and delete the vault from a
    /// tab. That is a hole in every install to buy a convenience for
    /// contributors; it is a flag they pass instead.
    dev_origin: Option<String>,
}

impl AppState {
    pub fn new(vault: Arc<Vault>, events: broadcast::Sender<Event>) -> Self {
        Self {
            vault,
            events,
            local: true,
            token: None,
            assets: None,
            ping: PING_EVERY,
            dev_origin: None,
        }
    }

    /// Ping an idle socket this often instead of every [`PING_EVERY`].
    ///
    /// Tests only, and marked so rather than left looking like an option an
    /// operator has: the cadence is not a knob anyone should turn, it is a
    /// number a test cannot afford to wait out.
    #[cfg(test)]
    pub fn with_ping(mut self, every: Duration) -> Self {
        self.ping = every;
        self
    }

    /// Read the UI from `dir` rather than from the embedded bundle.
    pub fn with_assets(mut self, dir: Option<PathBuf>) -> Self {
        self.assets = dir;
        self
    }

    /// Require this token from anything that is not loopback (§08 P12).
    /// Accept this origin as well as the one the app is served from.
    pub fn with_dev_origin(mut self, origin: Option<String>) -> Self {
        self.dev_origin = origin;
        self
    }

    pub fn with_token(mut self, token: Option<String>) -> Self {
        // An empty `--token ""` is a mistake, not a secret. Refusing it here
        // stops it becoming "remote mode is on and lets everyone in".
        self.token = token.filter(|value| !value.is_empty());
        self
    }

    /// Whether this server is in remote mode at all.
    pub fn guarded(&self) -> bool {
        self.token.is_some()
    }

    /// Record what the listener actually bound to.
    pub fn bound_to(mut self, addr: SocketAddr) -> Self {
        self.local = addr.ip().is_loopback();
        self
    }
}

/// Whether a request carries the token remote mode requires (§08 P12).
///
/// Two ways in, because a browser has only one of them: `Authorization: Bearer`
/// is what a script sends, and a cookie is what a WebSocket can carry — the
/// WebSocket API takes no headers, so a bearer-only scheme would leave the live
/// reload unauthenticated or unreachable. `?token=` on any request sets the
/// cookie, so the whole flow is: open the URL once with the token in it.
///
/// Compared byte by byte in constant time. A token check that returns early on
/// the first wrong character leaks its length and then its content to anyone
/// who can time it, and this one guards a whole vault over a network.
fn authorised(headers: &HeaderMap, uri: &Uri, expected: &str) -> bool {
    let offered = bearer(headers)
        .or_else(|| cookie_token(headers))
        .or_else(|| query_token(uri));

    match offered {
        Some(token) => constant_time_eq(token.as_bytes(), expected.as_bytes()),
        None => false,
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let rest = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))?;
    Some(rest.trim().to_owned())
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == TOKEN_COOKIE)
        .map(|(_, value)| value.to_owned())
}

fn query_token(uri: &Uri) -> Option<String> {
    uri.query()?
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(name, _)| *name == "token")
        .map(|(_, value)| value.to_owned())
}

/// The gate remote mode puts in front of everything.
///
/// Loopback is exempt: §08 P12 requires that "localhost stays tokenless", and a
/// request that reached 127.0.0.1 came from this machine, where the vault's
/// files are readable anyway. Everything else must present the token, including
/// the UI itself — serving the shell to an unauthenticated stranger tells them
/// a vault is here and what it is called.
/// What the gate decides. Separated from the plumbing so every combination can
/// be tested — a real remote peer is not something a unit test has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// Nothing was asked for: no token is configured, or the peer is this
    /// machine, which §08 P12 exempts.
    ///
    /// Deliberately distinct from the two below. A request that was never asked
    /// for a credential has not presented one, and must not inherit anything
    /// that presenting one earns.
    Allow,
    /// The token was presented and matched.
    Authenticated,
    /// Authenticated, and the token arrived in the URL — so hand back a cookie,
    /// which is the only way the WebSocket can carry it afterwards.
    AuthenticatedAndRemember,
    Refuse,
}

impl Gate {
    /// Whether the request proved it holds the token.
    ///
    /// The one source of the `Authenticated` marker, and the reason these are
    /// separate variants rather than a bool beside `Allow`. Keying the marker
    /// off the peer address instead — `if !peer_is_loopback` — handed the Host
    /// and Origin exemption to every stranger reaching a `--host 0.0.0.0` bind,
    /// token configured or not, which is exactly backwards.
    fn proved_the_token(self) -> bool {
        matches!(self, Gate::Authenticated | Gate::AuthenticatedAndRemember)
    }
}

/// The whole of remote mode's access rule (§08 P12).
pub fn decide(
    expected: Option<&str>,
    peer_is_loopback: bool,
    headers: &HeaderMap,
    uri: &Uri,
) -> Gate {
    // No token: the default, and the entire local experience.
    let Some(expected) = expected else {
        return Gate::Allow;
    };
    // §08 P12: "localhost stays tokenless". A request that reached 127.0.0.1
    // came from this machine, where the vault's files are readable anyway.
    if peer_is_loopback {
        return Gate::Allow;
    }
    if !authorised(headers, uri, expected) {
        return Gate::Refuse;
    }
    if query_token(uri).is_some() {
        return Gate::AuthenticatedAndRemember;
    }
    Gate::Authenticated
}

async fn token_gate(State(state): State<AppState>, request: Request, next: Next) -> Response {
    // Read from extensions rather than taken as an extractor: `ConnectInfo` is
    // only there when the service was built with it, and a missing peer must
    // mean "not loopback" rather than a rejected request.
    let peer_is_loopback = request
        .extensions()
        .get::<axum::extract::ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip().is_loopback())
        .unwrap_or(false);

    let gate = decide(
        state.token.as_deref(),
        peer_is_loopback,
        request.headers(),
        request.uri(),
    );

    // Captured before `next` consumes the request, for the redirect below.
    let target = request.uri().clone();
    // A navigation, and only a navigation. Excluding upgrades is not enough:
    // `GET /api/tree?token=…` is a perfectly ordinary way for a script to read
    // the vault, and answering it with a 303 replaces the JSON it asked for
    // with a redirect it may not follow. The address bar — the thing this
    // exists to clean — is only ever showing a document.
    let redirectable = request.method() == Method::GET
        && !request.headers().contains_key(header::UPGRADE)
        && !request.uri().path().starts_with("/api/");

    if gate == Gate::Refuse {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
            "this vault requires a token\n",
        )
            .into_response();
    }

    // Only a presented credential authenticates. A loopback peer is exempt from
    // the token but is exactly who a rebinding attack runs as, so it keeps the
    // Host rule — and so does a stranger on a tokenless `--host 0.0.0.0` bind,
    // who has proved nothing at all.
    let mut request = request;
    if let Some(mark) = Authenticated::earned_by(gate) {
        request.extensions_mut().insert(mark);
    }

    let mut response = next.run(request).await;
    // Presenting it once is enough. HttpOnly so a script cannot read it back
    // out, SameSite=Strict so another site cannot ride it, and no Secure flag
    // because a tailnet is plain HTTP by default.
    if gate == Gate::AuthenticatedAndRemember
        && let Some(token) = state.token.as_deref()
        && let Ok(cookie) =
            format!("{TOKEN_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict").parse()
    {
        response.headers_mut().insert(header::SET_COOKIE, cookie);

        // …and once it is a cookie, the copy in the address bar is a liability:
        // it survives in history, in a bookmark, and in the `Referer` of every
        // outbound link. Send the browser to the same page without it.
        //
        // Only for a document GET. A WebSocket upgrade cannot follow a redirect,
        // and `/api/events?token=…` is exactly how the socket authenticates
        // before the cookie exists.
        if redirectable && let Ok(location) = without_token(&target).parse() {
            *response.status_mut() = StatusCode::SEE_OTHER;
            response.headers_mut().insert(header::LOCATION, location);
        }
    }
    response
}

/// The same URI with `token=` dropped from the query.
///
/// Rebuilt rather than string-replaced: `?token=x&q=1`, `?q=1&token=x` and a
/// bare `?token=x` all have to come out right, and a `q` value that happens to
/// contain "token=" must survive.
///
/// The leading slashes are collapsed because this string becomes a `Location`.
/// A path of `//evil.example/` is not a path at all — it is a scheme-relative
/// URL, and a browser handed `Location: //evil.example/` leaves this origin
/// entirely. `/\evil.example` is the same hole, since browsers normalise the
/// backslash. Measured before the fix: `GET //evil.example/?token=…` answered
/// `303` with `location: //evil.example/`.
fn without_token(uri: &Uri) -> String {
    let path = format!("/{}", uri.path().trim_start_matches(['/', '\\']));
    let path = path.as_str();
    let kept: Vec<&str> = uri
        .query()
        .unwrap_or_default()
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter(|pair| pair.split_once('=').map(|(name, _)| name) != Some("token"))
        .collect();
    if kept.is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{}", kept.join("&"))
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
        // GET only. Nothing writes a non-note through the API, so the vault
        // cannot acquire a file its own tree will never show.
        .route("/api/file/{*path}", get(read_file))
        // DELETE only, and deliberately its own route rather than a recursive
        // mode on `/api/note`: teaching that one to accept a directory would
        // mean weakening `resolve`'s `.md` gate, which is the single definition
        // the tree, the write path and the watcher all share (§04 Rev P).
        .route("/api/folder/{*path}", delete(delete_folder))
        .route("/api/events", any(events))
        .route("/api/reveal", post(reveal))
        // §04's table listed six endpoints; §08 P9 asks for two more, because
        // `.register/` is invisible to the note API by design and the settings
        // screen has to reach the config and the licensed face somehow. The
        // vault *format* is untouched — both paths were already drawn in §04's
        // layout — so this grows the API table, not the contract.
        .route("/api/config", get(read_config).put(write_config))
        // The machine's half of the same idea (§04 Rev W). Its own route rather
        // than a query parameter on the one above, because they are two files
        // with two lifetimes: one travels with the vault and one does not.
        .route("/api/local", get(read_local).put(write_local))
        // §02b Screen 9. Deleting has never destroyed anything, and until now
        // the only way back was a `mv` in Finder — which meant knowing the
        // bucket name and reading a notice carefully at the moment you were
        // least inclined to.
        .route("/api/trash", get(list_trash))
        .route("/api/trash/{name}", post(restore_trash).delete(purge_trash))
        // §02b Screen 10. The INDEX is a register of notes, so a file nothing
        // references is invisible in the app.
        .route("/api/files", get(list_files))
        // §04 Rev Y. Deleting and creating both existed; the third of the set
        // did not, so reorganising a vault was still Finder's job.
        .route("/api/move", post(move_path))
        .route(
            "/api/font",
            get(read_font).put(write_font).delete(delete_font),
        )
        .fallback(asset)
        // Chosen deliberately. axum's default is 2 MiB, sized for web forms;
        // §04 puts no cap on a note, and a 2 MiB limit would reject a large
        // note with an unexplained 413 that nothing in the codebase decided on.
        .layer(DefaultBodyLimit::max(MAX_NOTE_BYTES))
        .layer(middleware::from_fn(hardening_headers))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            same_origin_only,
        ))
        // Outside `same_origin_only`, so it runs first: an unauthenticated
        // stranger is refused before anything reasons about their Origin.
        .layer(middleware::from_fn_with_state(state.clone(), token_gate))
        .with_state(state)
}

pub async fn listener(host: &str, port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind((host, port)).await
}

pub async fn serve(listener: TcpListener, state: AppState) -> std::io::Result<()> {
    // With connect info, so the token gate can tell a request from this machine
    // from one off the network. §08 P12: "localhost stays tokenless".
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await
}

/// Resolves when the operator asks the process to stop.
///
/// `docker stop` sends SIGTERM and waits ten seconds before SIGKILL, and until
/// now nothing here listened for either — the process was simply killed. That
/// was survivable while there was nothing to release: writes are tmp-file plus
/// rename, so a death mid-write leaves the old note or the new one and never
/// half of either. It stopped being survivable the moment the vault started
/// carrying a claim, which a killed process leaves behind for the next one to
/// trip over.
///
/// `tokio`'s `signal` feature has been in `Cargo.toml` since P0 and called
/// nowhere; this is what it was for.
async fn shutdown() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    // SIGTERM is Unix-only. On Windows ctrl-c is the whole story, and the
    // pending future below simply never wins the select.
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            // Nothing to be done and nothing worth saying: the process still
            // stops on ctrl-c, and a failure to register a handler is not a
            // reason to refuse to serve.
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = interrupt => {}
        _ = terminate => {}
    }
    println!("register · stopping");
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

/// A file the vault holds that is not a note — the images and PDFs a note
/// references (§04 Rev O).
///
/// Read-only on purpose. The write surface stays `.md`-only, so `resolve`'s one
/// definition of a note still governs everything that can create a file, and
/// this endpoint cannot put anything in the vault that the tree will not show.
///
/// Conditional first: a `stat` decides the 304 before any bytes are allocated.
/// `ETag` rather than the font endpoint's `no-store` — these are the user's own
/// files in their own browser, and re-sending a 4 MB diagram on every navigation
/// is the cost worth avoiding. The font endpoint's reason for `no-store` was
/// that the bytes are licensed property; that does not apply here.
async fn read_file(
    State(state): State<AppState>,
    Path(path): Path<String>,
    headers: HeaderMap,
) -> Response {
    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim_matches('"').to_owned());

    if let Some(wanted) = if_none_match {
        let vault = state.vault.clone();
        let known = path.clone();
        if let Ok(current) = blocking(move || vault.media_etag(&known)).await
            && current == wanted
        {
            return (StatusCode::NOT_MODIFIED, [(header::ETAG, quoted(&current))]).into_response();
        }
    }

    let vault = state.vault.clone();
    match blocking(move || vault.read_media(&path)).await {
        Ok((bytes, format, etag)) => (
            StatusCode::OK,
            [
                (header::ETAG, quoted(&etag)),
                // A `&'static str` from the format table, never a caller string.
                // `nosniff` is set on every response, so this has to be right or
                // the browser renders nothing rather than guessing.
                (header::CONTENT_TYPE, format.media_type.to_owned()),
                // SVG is XML that can carry script, and it is served from this
                // origin — so on that one response the policy is tightened to
                // nothing at all. `sandbox` with no tokens denies scripting,
                // plugins, forms, navigation and same-origin access in one word;
                // `default-src 'none'` stops it fetching anything it might want
                // to phone home with. The image still draws: `<img>` never runs
                // script in an SVG anyway, and this closes the case where it is
                // opened on its own surface or framed.
                //
                // Per-response rather than global for the reason the PDF route
                // already relaxes `frame-ancestors` on itself: one format, one
                // header, and every other response keeps what it had. Excluding
                // SVG outright was the Rev O position and it cost the product the
                // output format of every diagram tool — a real cost paid to a
                // threat a sandbox closes.
                //
                // **SVG only.** Setting a policy on every file response was the
                // first attempt and it broke Screen 8: the header layer defers to
                // a policy a handler set, so a PDF stopped getting
                // `frame-ancestors 'self'` and the app could no longer frame its
                // own viewer. Anything that is only pixels keeps the frame-wide
                // policy, which is the one that carries that carve-out.
                (
                    header::CONTENT_SECURITY_POLICY,
                    if format.media_type == "image/svg+xml" {
                        "sandbox; default-src 'none'; style-src 'unsafe-inline'".to_owned()
                    } else {
                        // Empty means "the frame-wide policy applies", which is
                        // what the header layer reads it as.
                        String::new()
                    },
                ),
            ],
            bytes,
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

async fn delete_note(
    State(state): State<AppState>,
    Path(path): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = stale_revision(&state, &headers) {
        return response;
    }
    let vault = state.vault.clone();
    match blocking(move || vault.trash(&path)).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(response) => response,
    }
}

/// Refuse a deletion whose `If-Match` names a revision the vault has left
/// behind (§04 Rev X).
///
/// Every write is guarded by an etag and no deletion was, so a note an agent
/// edited in the second between the confirm being drawn and answered was trashed
/// carrying that edit. Nothing was lost — it is in the bucket — but the reader
/// agreed to a different file than the one that went. An etag cannot describe a
/// subtree, which is why a folder deletion had nothing to be guarded by at all,
/// and why the guard is the tree's revision rather than any file's.
///
/// Absent means unguarded, deliberately: `curl -X DELETE` is a documented way to
/// use this API and demanding a revision it has no way to have read would break
/// it. The client always sends one.
fn stale_revision(state: &AppState, headers: &HeaderMap) -> Option<Response> {
    let wanted: u64 = headers
        .get(header::IF_MATCH)
        .and_then(|value| value.to_str().ok())
        .map(unquoted)?
        .parse()
        .ok()?;
    let now = state.vault.revision();
    if wanted == now {
        return None;
    }
    Some(
        (
            StatusCode::CONFLICT,
            [(header::ETAG, quoted(&now.to_string()))],
            "the vault changed while you were being asked\n",
        )
            .into_response(),
    )
}

/// Trash a folder and everything under it, in one bucket (§04 Rev P).
///
/// Answers with what it moved rather than `204`, because the count is the point:
/// the client confirms against the notes the INDEX draws and cannot see the rest
/// of the folder, so this is the only honest report of what left.
async fn delete_folder(
    State(state): State<AppState>,
    Path(path): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = stale_revision(&state, &headers) {
        return response;
    }
    let vault = state.vault.clone();
    match blocking(move || vault.trash_folder(&path)).await {
        Ok(trashed) => Json(trashed).into_response(),
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
    let mut child = std::process::Command::new(program).arg(path).spawn()?;
    // Rust never waits on a dropped Child, so every reveal would leave a zombie
    // holding a PID slot — in a process designed to run for days, against a
    // command a user can hold down. Reaped on a detached thread so a file
    // manager that lingers cannot block the response.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Rename or move a note or a folder (§04 Rev Y).
///
/// One route for both, because on disk they are one operation: a rename *is* a
/// move to a different name, and a folder is renamed by the same call that
/// renames a note. Refuses an occupied destination rather than merging, since
/// §04 never destroys.
#[derive(serde::Deserialize)]
struct Move {
    from: String,
    to: String,
}

async fn move_path(State(state): State<AppState>, Json(wanted): Json<Move>) -> Response {
    let vault = state.vault.clone();
    match blocking(move || vault.rename(&wanted.from, &wanted.to)).await {
        Ok(moved) => Json(moved).into_response(),
        Err(response) => response,
    }
}

/// Every deletion still recoverable (§02b Screen 9).
async fn list_trash(State(state): State<AppState>) -> Response {
    let vault = state.vault.clone();
    match blocking(move || vault.buckets()).await {
        Ok(buckets) => Json(buckets).into_response(),
        Err(response) => response,
    }
}

/// Put a bucket back where it came from.
///
/// `POST` rather than `PUT`: it is not idempotent in the sense that matters —
/// running it twice restores nothing the second time and the answer differs —
/// and there is no representation the caller is supplying.
async fn restore_trash(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    let vault = state.vault.clone();
    match blocking(move || vault.restore(&name)).await {
        Ok(restored) => Json(restored).into_response(),
        Err(response) => response,
    }
}

/// Destroy a bucket. The one route in this API that really deletes.
async fn purge_trash(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    let vault = state.vault.clone();
    match blocking(move || vault.purge(&name)).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(response) => response,
    }
}

/// Every non-note file in the vault (§02b Screen 10).
///
/// Paths only. What references what is the client's to work out: it holds every
/// note body already, and the server answering would mean parsing prose to
/// answer a question about files.
async fn list_files(State(state): State<AppState>) -> Response {
    let vault = state.vault.clone();
    match blocking(move || vault.files()).await {
        Ok(files) => Json(files).into_response(),
        Err(response) => response,
    }
}

// ------------------------------------------------------------ config + fonts

async fn read_config(State(state): State<AppState>) -> Response {
    let vault = state.vault.clone();
    match blocking(move || vault.read_config()).await {
        Ok(body) => ([(header::CONTENT_TYPE, "application/json")], body).into_response(),
        Err(response) => response,
    }
}

async fn write_config(State(state): State<AppState>, body: String) -> Response {
    // Parsed before it is stored. The client is the only writer, but a config
    // file that is not JSON would make every later read fail in the browser, at
    // boot, with nothing on screen to explain it.
    if serde_json::from_str::<serde_json::Value>(&body).is_err() {
        return (StatusCode::BAD_REQUEST, "config must be JSON\n").into_response();
    }

    let vault = state.vault.clone();
    match blocking(move || vault.write_config(&body)).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(response) => response,
    }
}

/// This machine's half of the settings (§04 Rev W).
///
/// `config.json` is tracked, so every setting in it was a diff — switching to
/// dark dirtied the vault, and committing it pushed your theme at whoever you
/// shared it with. The scheme, the body face and the plate scale are about the
/// machine you are sitting at; the collapsed folders and the checkpoint flag are
/// about the content and should travel with it. Two files rather than one
/// compromise that gets half of them wrong.
async fn read_local(State(state): State<AppState>) -> Response {
    let vault = state.vault.clone();
    match blocking(move || vault.read_local()).await {
        Ok(body) => ([(header::CONTENT_TYPE, "application/json")], body).into_response(),
        Err(response) => response,
    }
}

async fn write_local(State(state): State<AppState>, body: String) -> Response {
    // Parsed before it is stored, for `write_config`'s reason: a settings file
    // that is not JSON fails every later read at boot with nothing on screen.
    if serde_json::from_str::<serde_json::Value>(&body).is_err() {
        return (StatusCode::BAD_REQUEST, "local settings must be JSON\n").into_response();
    }

    let vault = state.vault.clone();
    match blocking(move || vault.write_local(&body)).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(response) => response,
    }
}

/// The licensed face, served back to the page that stored it (§03 BYOF).
///
/// `no-store`: these bytes are the user's licensed property and a cache entry is
/// a copy of them somewhere nobody chose to put one.
async fn read_font(State(state): State<AppState>) -> Response {
    let vault = state.vault.clone();
    let found = blocking(move || Ok(vault.font())).await;

    match found {
        Ok(Some((path, media_type))) => match tokio::fs::read(&path).await {
            Ok(bytes) => (
                [
                    (header::CONTENT_TYPE, media_type),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                bytes,
            )
                .into_response(),
            Err(_) => (StatusCode::NOT_FOUND, "no licensed font\n").into_response(),
        },
        Ok(None) => (StatusCode::NOT_FOUND, "no licensed font\n").into_response(),
        Err(response) => response,
    }
}

async fn write_font(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let vault = state.vault.clone();
    match blocking(move || vault.write_font(&body)).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(response) => response,
    }
}

async fn delete_font(State(state): State<AppState>) -> Response {
    let vault = state.vault.clone();
    match blocking(move || vault.remove_font()).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(response) => response,
    }
}

async fn events(upgrade: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let events = state.events.subscribe();
    let every = state.ping;
    upgrade.on_upgrade(move |socket| pump(socket, events, every))
}

/// How often to ping a client that has heard nothing.
///
/// A vault can be quiet for hours, and a TCP connection that has died — a
/// laptop closed on a tailnet, a sleeping phone, a NAT table that dropped the
/// entry — looks exactly like a quiet one from this end. Without traffic
/// nothing discovers it: the socket sits open, the client believes it is live,
/// and the next agent edit is delivered to nobody. §07's remote mode (P12) is
/// what made this reachable; on loopback it never mattered.
const PING_EVERY: Duration = Duration::from_secs(30);

/// How long a single frame may take to leave.
///
/// A half-open connection accepts writes into the kernel buffer until it fills,
/// and then blocks forever. Without this the pump would park on that `send` and
/// hold its broadcast slot for the life of the process.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

/// Forward coalesced vault events to one client until either side hangs up.
async fn pump(mut socket: WebSocket, mut events: broadcast::Receiver<Event>, every: Duration) {
    let mut ping = tokio::time::interval(every);
    // The first tick is immediate; a ping the moment the socket opens says
    // nothing useful and races the client's own setup.
    ping.tick().await;

    loop {
        tokio::select! {
            _ = ping.tick() => {
                // The payload is empty: this asks "are you there", and the
                // answer is the pong axum handles for us. A `Pong` arriving
                // unsolicited is fine too and falls through the arm below.
                if timeout(SEND_TIMEOUT, socket.send(Message::Ping(Vec::new().into())))
                    .await
                    .map(|sent| sent.is_err())
                    .unwrap_or(true)
                {
                    return;
                }
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                _ => {}
            },
            event = events.recv() => match event {
                Ok(event) => {
                    let Ok(frame) = serde_json::to_string(&event) else { continue };
                    // Timed for the same reason the ping is: a half-open socket
                    // takes writes until the kernel buffer fills and then blocks
                    // for good, holding this task and its broadcast slot.
                    if timeout(SEND_TIMEOUT, socket.send(Message::Text(frame.into())))
                        .await
                        .map(|sent| sent.is_err())
                        .unwrap_or(true)
                    {
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

/// Resolve a request path inside `root`, or `None` if it would escape.
///
/// The directory is the operator's choice; the path is the caller's, so it gets
/// the same treatment `vault.rs` gives a note path. Lexically first — only
/// ordinary segments, no `..`, no absolute paths, no dot-prefixed names — and
/// then canonicalised and checked against the root, because a symlink inside
/// the directory would otherwise walk straight out of it.
fn under(root: &FsPath, request: &str) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for part in FsPath::new(request).components() {
        match part {
            Component::Normal(name) => {
                if name.to_str().is_some_and(|text| text.starts_with('.')) {
                    return None;
                }
                out.push(name);
            }
            _ => return None,
        }
    }

    let resolved = out.canonicalize().ok()?;
    let base = root.canonicalize().ok()?;
    if !resolved.starts_with(&base) {
        return None;
    }

    // The dot check above reads the *request*; this one reads where it landed.
    // A symlink inside the assets root whose own name has no dot — `pub` ->
    // `.private` — satisfies the first check and still resolves into a hidden
    // directory, and because the target is inside the root the containment test
    // is happy too. Both halves have to agree on what is hidden.
    let hidden = resolved
        .strip_prefix(&base)
        .ok()?
        .components()
        .any(|part| match part {
            Component::Normal(name) => name.to_str().is_some_and(|text| text.starts_with('.')),
            _ => true,
        });
    (!hidden).then_some(resolved)
}

/// The UI from disk, for `--assets`. `None` means "not there", never "escaped".
fn from_disk(root: &FsPath, wanted: &str) -> Option<(&'static str, Vec<u8>)> {
    let path = under(root, wanted).filter(|path| path.is_file())?;
    let bytes = std::fs::read(&path).ok()?;
    Some((media_type(&path), bytes))
}

/// The media types a built UI actually contains. A match rather than a crate:
/// `vite build` emits exactly these, and anything else is served as bytes.
fn media_type(path: &FsPath) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

async fn asset(State(state): State<AppState>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    // An unmatched /api/* is a routing mistake, never a page. Answering it with
    // the SPA shell would turn a 404 into a silently successful HTML response.
    if path == "api" || path.starts_with("api/") {
        return (StatusCode::NOT_FOUND, "no such endpoint\n").into_response();
    }

    let wanted = if path.is_empty() { "index.html" } else { path };

    if let Some(root) = state.assets.as_deref() {
        // Same fallback as the embedded path: an unknown route is the shell,
        // because the client owns routing.
        return match from_disk(root, wanted).or_else(|| from_disk(root, "index.html")) {
            Some((mime, bytes)) => {
                (StatusCode::OK, [(header::CONTENT_TYPE, mime)], bytes).into_response()
            }
            None => (
                StatusCode::NOT_FOUND,
                format!("no UI in {}; run `cd app && pnpm build`\n", root.display()),
            )
                .into_response(),
        };
    }

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
/// Marks a request that proved it holds remote mode's token.
///
/// Set by the token gate and read by the origin guard, because the two rules
/// are about different attackers and only one of them applies at a time.
#[derive(Clone, Copy)]
struct Authenticated;

impl Authenticated {
    /// The only way to make one, and it takes the gate's own answer.
    ///
    /// The point is that a peer address cannot reach this. The bug was a
    /// `request.extensions_mut().insert(Authenticated)` guarded by
    /// `!peer_is_loopback`, which reads plausibly and is wrong; routing every
    /// marker through here means the next person has to pass a `Gate` that
    /// already said the token was proved.
    fn earned_by(gate: Gate) -> Option<Self> {
        gate.proved_the_token().then_some(Self)
    }
}

/// Headers on every response, for the attacks the Origin rule cannot reach.
///
/// The origin guard decides who may *make* a request. None of it stops a hostile
/// page from putting the UI in an invisible iframe and letting the user click
/// through it, because that page never makes a request at all — the browser does,
/// as a top-level navigation the user appears to have asked for.
///
/// `frame-ancestors 'none'` is the one that matters; `X-Frame-Options` repeats it
/// for anything that predates CSP. The rest is cheap: the UI loads nothing from
/// anywhere, so a restrictive `default-src` costs nothing and turns any future
/// injected `<script src>` into a console error instead of vault access.
/// `form-action 'none'` because there is no form to submit anywhere.
/// The ` ws://host wss://host` fragment for this request's own origin, or empty.
///
/// `connect-src 'self'` ought to cover a same-origin WebSocket, and in Chromium
/// it does. Not everywhere: WebKit has long treated `ws:` as a scheme distinct
/// from the document's `http:` and refused it under `'self'`. A blocked socket
/// makes `new WebSocket` *throw* rather than fire `onerror`, so the client never
/// reaches its reconnect path and the WATCHER lamp stays dark for the session.
/// Naming the authority removes the argument.
///
/// Sanitised because the result is interpolated into a policy: a `;` in the Host
/// header would end the directive and begin one of the sender's choosing.
fn socket_origin(headers: &HeaderMap) -> String {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .filter(|host| {
            !host.is_empty()
                && host.len() <= 255
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b":.-[]".contains(&b))
        })
        .map(|host| format!(" ws://{host} wss://{host}"))
        .unwrap_or_default()
}

async fn hardening_headers(request: Request, next: Next) -> Response {
    // `connect-src 'self'` ought to cover a same-origin WebSocket, and in
    // Chromium it does. Not everywhere: WebKit has long treated `ws:` as a
    // different scheme from the document's `http:` and refused it under
    // `'self'` — and a blocked socket makes `new WebSocket` *throw*, so the
    // client never even reaches its reconnect path and the WATCHER lamp stays
    // dark for good. Naming the origin's own authority removes the argument.
    let same_origin_socket = socket_origin(request.headers());

    // The one response that may be framed, and only by us.
    //
    // §02b Screen 8 shows a PDF in an `<iframe>` on the browser's own viewer —
    // `object-src 'none'` rules out `<embed>`, and pdf.js is ~350 kB gz against
    // a 150 kB editor budget. `frame-ancestors` and `X-Frame-Options` are read
    // from the *framed* resource, not the framing page, so the app was refused
    // by its own headers: measured in a browser as "Framing … violates …
    // frame-ancestors 'none'".
    //
    // Narrowed to `'self'` rather than dropped: a cross-origin page still
    // cannot frame a vault file, and every other response — the app shell above
    // all — keeps `'none'`. Matched on the path because the header layer runs
    // outside the router and has no route to ask.
    let framable = request.uri().path().starts_with("/api/file/");
    let frame_ancestors = if framable { "'self'" } else { "'none'" };

    let policy = format!(
        "default-src 'self'; \
         frame-ancestors {frame_ancestors}; \
         form-action 'none'; \
         base-uri 'none'; \
         object-src 'none'; \
         img-src 'self' data: blob:; \
         font-src 'self' data: blob:; \
         connect-src 'self'{same_origin_socket}; \
         style-src 'self' 'unsafe-inline'"
    );
    let policy = policy.as_str();

    let mut response = next.run(request).await;
    // A handler that set its own policy meant it. `read_file` tightens this to
    // `sandbox; default-src 'none'` for an SVG, which is XML that can carry
    // script and is served from this origin — and inserting the frame-wide
    // policy over the top would undo exactly the response that needed it. Only
    // *tighter* policies are ever set below, so deferring cannot loosen
    // anything: the alternative shape, teaching this layer which routes are
    // special, is what already made `framable` a path match rather than a
    // decision the route makes.
    // A *non-empty* policy, because a handler that wants the frame-wide one sets
    // an empty value rather than reasoning about how to omit a header from a
    // fixed-size array. Checking `contains_key` alone read that empty value as a
    // policy and suppressed the real one — which is how the PDF route briefly
    // lost `frame-ancestors 'self'` and the app stopped being able to frame its
    // own viewer.
    let owns_its_policy = response
        .headers()
        .get(header::CONTENT_SECURITY_POLICY)
        .is_some_and(|value| !value.is_empty());
    let headers = response.headers_mut();
    for (name, value) in [
        (
            header::CONTENT_SECURITY_POLICY,
            if owns_its_policy { "" } else { policy },
        ),
        // Legacy, and still honoured — a `DENY` here would override the CSP
        // above and refuse the frame anyway, so the two have to agree.
        (
            header::X_FRAME_OPTIONS,
            if framable { "SAMEORIGIN" } else { "DENY" },
        ),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        // The token can arrive in a URL once, before the redirect swaps it for a
        // cookie. Until that redirect lands, this is what keeps it out of the
        // Referer of anything the page links to.
        (header::REFERRER_POLICY, "no-referrer"),
    ] {
        // An empty value is the "leave it alone" signal from the table above,
        // never a header worth sending.
        if value.is_empty() {
            continue;
        }
        if let Ok(value) = value.parse() {
            headers.insert(name, value);
        }
    }
    response
}

async fn same_origin_only(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, Response> {
    // A request that presented the token is authenticated, and the Host rule
    // below does not apply to it.
    //
    // That rule exists for DNS rebinding: a hostile page whose domain resolves
    // to 127.0.0.1 is same-origin by the browser's reckoning, so it can reach a
    // *local* server without an Origin header. It cannot reach a remote one,
    // and it cannot obtain the token — the cookie is HttpOnly and SameSite=Strict,
    // so a cross-site request never carries it and script cannot read it. In
    // remote mode the token is the check; demanding a loopback Host as well
    // simply makes remote mode impossible, which is what it did.
    if request.extensions().get::<Authenticated>().is_some() {
        return Ok(next.run(request).await);
    }

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

    // Same origin, or the one origin an operator named. Any loopback origin used
    // to pass, because `pnpm dev` serves the UI from vite on another port — and
    // that handed the same authority to every other web server on the machine.
    // A page on `http://localhost:3000`, in any tab, could read the vault, write
    // to it and delete from it. It needed no second user account and no hostile
    // file: just something else listening. So the convenience is a flag now, and
    // the default is what the browser calls same-origin.
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let allowed = state.dev_origin.clone();
    let foreign = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| !origin_is_ours(origin, &host, allowed.as_deref()));
    if foreign {
        return Err((StatusCode::FORBIDDEN, "cross-origin request refused\n").into_response());
    }

    Ok(next.run(request).await)
}

/// Is this `Origin` the one the app is served from, or the one named by
/// `--dev-origin`?
///
/// Compared by authority rather than by string, because `Origin` carries a
/// scheme and `Host` does not — and the scheme is checked separately, since an
/// `Origin` of anything but http/https is not a page this app served.
fn origin_is_ours(origin: &str, host: &str, dev: Option<&str>) -> bool {
    if dev.is_some_and(|allowed| allowed.eq_ignore_ascii_case(origin.trim_end_matches('/'))) {
        return true;
    }
    let Some((scheme, authority)) = origin.split_once("://") else {
        return false;
    };
    if scheme != "http" && scheme != "https" {
        return false;
    }
    // The port matters: `localhost:3000` and `localhost:7777` are different
    // origins to a browser and must be different here.
    authority.eq_ignore_ascii_case(host)
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
        vault::Error::NoSuchFolder => (StatusCode::NOT_FOUND, "no such folder\n").into_response(),
        // 409, the same status a stale etag gets, and for the same reason: the
        // client assumed something about the vault that stopped being true, and
        // the answer is to look again rather than to change the request. It
        // refetches the tree, takes the next free ref and writes.
        vault::Error::RefTaken { taken } => (
            StatusCode::CONFLICT,
            format!("that ref is already held by {taken}\n"),
        )
            .into_response(),
        // Startup-only: `claim` is taken before the listener binds, so no
        // request can ever produce this. Mapped rather than left to a catch-all
        // so that adding a variant keeps failing this match until somebody has
        // decided what it means over HTTP.
        vault::Error::AlreadyServed { .. } => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "this vault is served by another process\n",
        )
            .into_response(),
        vault::Error::UnsupportedFont => (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "not a woff2, woff, otf or ttf font\n",
        )
            .into_response(),
        // The same 415 the font endpoint gives, for the same reason: the bytes
        // are not a container this app will hand to a browser. Says which ones
        // it will, because "unsupported" alone sends the reader to the source.
        vault::Error::UnsupportedMedia => (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "not a png, jpeg, gif, webp, avif or pdf\n",
        )
            .into_response(),
        vault::Error::TooLarge => (
            StatusCode::PAYLOAD_TOO_LARGE,
            "file is larger than this app will serve\n",
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
