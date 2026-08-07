//! HTTP + WebSocket surface. §04's API table is normative: these six endpoints
//! are the entire server. Refs, links, tasks, tags, search and templates are all
//! client-side derivations of plain text — the sixth endpoint, `/api/reveal`,
//! exists only because opening a file manager is something a browser cannot do
//! for itself (§08 P5).

use std::net::SocketAddr;
use std::path::{Component, Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
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
}

impl AppState {
    pub fn new(vault: Arc<Vault>, events: broadcast::Sender<Event>) -> Self {
        Self {
            vault,
            events,
            local: true,
            token: None,
            assets: None,
        }
    }

    /// Read the UI from `dir` rather than from the embedded bundle.
    pub fn with_assets(mut self, dir: Option<PathBuf>) -> Self {
        self.assets = dir;
        self
    }

    /// Require this token from anything that is not loopback (§08 P12).
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
        .route("/api/events", any(events))
        .route("/api/reveal", post(reveal))
        // §04's table listed six endpoints; §08 P9 asks for two more, because
        // `.register/` is invisible to the note API by design and the settings
        // screen has to reach the config and the licensed face somehow. The
        // vault *format* is untouched — both paths were already drawn in §04's
        // layout — so this grows the API table, not the contract.
        .route("/api/config", get(read_config).put(write_config))
        .route(
            "/api/font",
            get(read_font).put(write_font).delete(delete_font),
        )
        .fallback(asset)
        // Chosen deliberately. axum's default is 2 MiB, sized for web forms;
        // §04 puts no cap on a note, and a 2 MiB limit would reject a large
        // note with an unexplained 413 that nothing in the codebase decided on.
        .layer(DefaultBodyLimit::max(MAX_NOTE_BYTES))
        .layer(middleware::from_fn(same_origin_only))
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
    .await
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
    resolved.starts_with(&base).then_some(resolved)
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

async fn same_origin_only(request: Request, next: Next) -> Result<Response, Response> {
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
        vault::Error::UnsupportedFont => (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "not a woff2, woff, otf or ttf font\n",
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
