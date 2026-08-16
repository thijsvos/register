use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::broadcast;

use super::*;
use crate::vault::tests::TempVault;

/// A parsed HTTP response. Spoken over a raw socket rather than through a
/// client crate: §08 P2's acceptance is "curl round-trip works", and neither
/// reqwest nor tower's test helpers are on §04's dependency list.
struct Reply {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

async fn request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    extra: &[(&str, &str)],
    body: &str,
) -> Reply {
    let mut stream = TcpStream::connect(addr).await.expect("connect");

    // An explicit Host REPLACES the default rather than being appended. Sending
    // two Host headers is a malformed request, and hyper answers from the first
    // one — so a test that appended would silently exercise `localhost` while
    // appearing to test a rebound name.
    let host = extra
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("host"))
        .map(|(_, value)| *value)
        .unwrap_or("localhost");

    // `Connection: close` lets read_to_end terminate without parsing lengths.
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (name, value) in extra {
        if name.eq_ignore_ascii_case("host") {
            continue;
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");

    stream.write_all(head.as_bytes()).await.expect("write head");
    stream.write_all(body.as_bytes()).await.expect("write body");

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("read");
    let raw = String::from_utf8_lossy(&raw).into_owned();

    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw.as_str(), ""));
    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let headers = lines
        .filter_map(|line| line.split_once(": "))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.to_owned()))
        .collect();

    Reply {
        status,
        headers,
        body: body.to_owned(),
    }
}

async fn start(tmp: &TempVault) -> SocketAddr {
    start_with(tmp, None).await
}

/// A WebSocket handshake, spoken by hand, returning the status line's code.
///
/// `request` above always sends `Connection: close`, which contradicts
/// `Connection: Upgrade` — hyper then answers the malformed request and a test
/// asserting "the upgrade was refused" passes without the guard ever running.
/// Verified against the real binary: this shape gets 101 where that one gets 400.
async fn upgrade(addr: SocketAddr, path: &str, extra: &[(&str, &str)]) -> u16 {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let host = extra
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("host"))
        .map(|(_, value)| *value)
        .unwrap_or("localhost");

    let mut head = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    );
    for (name, value) in extra {
        if name.eq_ignore_ascii_case("host") {
            continue;
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.expect("write");

    let mut buf = [0u8; 256];
    let read = stream.read(&mut buf).await.expect("read");
    String::from_utf8_lossy(&buf[..read])
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0)
}

/// A WebSocket that stays open, so the frames after the handshake can be read.
///
/// `upgrade` above returns the status code and drops the stream, which is all
/// the refusal tests need and none of what a keepalive test does.
async fn upgraded(addr: SocketAddr) -> TcpStream {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream
        .write_all(
            b"GET /api/events HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\n\
              Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\
              Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        )
        .await
        .expect("write upgrade");

    // Exactly the headers: reading further would swallow the first frame, which
    // is the one under test.
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.expect("read handshake");
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    assert!(head.starts_with("HTTP/1.1 101"), "upgrade refused: {head}");
    stream
}

#[tokio::test]
async fn an_idle_socket_is_pinged() {
    // A vault can be quiet for hours, and a connection that has died — a laptop
    // closed on a tailnet, a NAT entry dropped — looks exactly like a quiet one
    // from this end. Without traffic nothing discovers it: the socket stays
    // open, the client believes it is live, and the next agent edit is
    // delivered to nobody. §07's remote mode is what made that reachable.
    let tmp = TempVault::new();
    let vault = Arc::new(tmp.open());
    let (events, _keep) = broadcast::channel(64);
    let state = AppState::new(vault, events).with_ping(Duration::from_millis(60));

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router(state)).await;
    });

    let mut socket = upgraded(addr).await;

    // Nothing is written to the vault, so a frame arriving at all is the ping.
    let mut header = [0u8; 2];
    let read = tokio::time::timeout(Duration::from_secs(2), socket.read_exact(&mut header)).await;
    assert!(
        read.is_ok(),
        "no frame inside two seconds — an idle socket was never pinged"
    );
    read.expect("timeout").expect("read frame");

    // Opcode 9 is Ping (RFC 6455). Text would mean an event nobody caused.
    assert_eq!(
        header[0] & 0x0f,
        0x9,
        "expected a ping, got opcode {:x}",
        header[0] & 0x0f
    );

    // And it does not fire the instant the socket opens, which would say nothing
    // about liveness and would race the client's own setup.
    let payload = usize::from(header[1] & 0x7f);
    assert_eq!(payload, 0, "the ping carries no payload");
}

/// A server in remote mode: bound to loopback, but demanding a token from
/// anything that is not loopback. The tests reach it over 127.0.0.1, which is
/// exactly the exemption §08 P12 requires — so the refusals below are driven by
/// a forged peer rather than by a real remote host.
async fn start_with(tmp: &TempVault, token: Option<&str>) -> SocketAddr {
    let vault = Arc::new(tmp.open());
    let (events, _keep) = broadcast::channel(64);
    let state = AppState::new(vault, events).with_token(token.map(str::to_owned));

    let bound = listener("127.0.0.1", 0).await.expect("bind");
    let addr = bound.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = serve(bound, state).await;
    });
    addr
}

/// A server that never tells the gate who the peer is — which is precisely how
/// the gate sees anything that is not this machine.
///
/// `serve` attaches `ConnectInfo`; serving the router without it leaves the
/// extension absent, and `token_gate` reads absent as "not loopback" because a
/// missing peer must fail closed. So this is a real socket carrying the real
/// middleware stack, with the one bit flipped that a LAN peer would flip — and
/// it needs no second network interface on the machine running the suite.
async fn start_as_stranger(tmp: &TempVault, token: Option<&str>) -> SocketAddr {
    let vault = Arc::new(tmp.open());
    let (events, _keep) = broadcast::channel(64);
    let state = AppState::new(vault, events).with_token(token.map(str::to_owned));

    let bound = listener("127.0.0.1", 0).await.expect("bind");
    let addr = bound.local_addr().expect("local addr");
    tokio::spawn(async move {
        // Deliberately not `into_make_service_with_connect_info`.
        let _ = axum::serve(bound, router(state)).await;
    });
    addr
}

const NOTE: &str = "---\nid: 01J2ZK7Q8W3E5R9T\nref: 003\ntitle: Terminal aesthetics\ncreated: 2026-07-28\nmodified: 2026-08-04T13:47:00Z\ntags: [design, research]\n---\nBody.\n";

// ------------------------------------------------------------------ wiring

#[test]
fn routes_build() {
    // axum 0.8 rejects the 0.7 `:param` / `*wildcard` spellings by PANICKING at
    // Router construction, not at compile time. Without this, a typo'd route
    // would build clean and take the server down on boot.
    let tmp = TempVault::new();
    let (events, _keep) = broadcast::channel(1);
    let _ = router(AppState::new(Arc::new(tmp.open()), events));
}

// -------------------------------------------------------------- round trips

#[tokio::test]
async fn writes_then_reads_a_note_back() {
    let tmp = TempVault::new();
    let addr = start(&tmp).await;

    let put = request(addr, "PUT", "/api/note/notes/003-a.md", &[], NOTE).await;
    assert_eq!(put.status, 200);
    assert!(put.headers.contains_key("etag"));

    let get = request(addr, "GET", "/api/note/notes/003-a.md", &[], "").await;
    assert_eq!(get.status, 200);
    assert_eq!(get.body, NOTE);
    assert_eq!(get.headers.get("etag"), put.headers.get("etag"));
}

#[tokio::test]
async fn the_tree_reports_derived_metadata() {
    let tmp = TempVault::new();
    tmp.put("notes/003-terminal-aesthetics.md", NOTE);
    let addr = start(&tmp).await;

    let reply = request(addr, "GET", "/api/tree", &[], "").await;
    assert_eq!(reply.status, 200);
    // The §04 envelope: where the vault lives and which ref comes next are
    // properties of the vault, not of any one note.
    assert!(reply.body.contains("\"vault\":"), "{}", reply.body);
    assert!(reply.body.contains("\"nextRef\":\"004\""), "{}", reply.body);
    assert!(reply.body.contains("\"notes\":["), "{}", reply.body);
    assert!(
        reply
            .body
            .contains("\"path\":\"notes/003-terminal-aesthetics.md\"")
    );
    assert!(reply.body.contains("\"ref\":\"003\""));
    assert!(reply.body.contains("\"title\":\"Terminal aesthetics\""));
    assert!(reply.body.contains("design"));
}

#[tokio::test]
async fn reading_a_missing_note_is_404() {
    let tmp = TempVault::new();
    let addr = start(&tmp).await;

    let reply = request(addr, "GET", "/api/note/notes/nope.md", &[], "").await;
    assert_eq!(reply.status, 404);
}

// ----------------------------------------------------------- etag conflict

#[tokio::test]
async fn a_concurrent_put_with_a_stale_etag_is_409() {
    let tmp = TempVault::new();
    let addr = start(&tmp).await;

    let created = request(addr, "PUT", "/api/note/notes/003-a.md", &[], "one").await;
    assert_eq!(created.status, 200);
    let shared = created.headers.get("etag").expect("etag").clone();

    // Two clients hold the same etag. The first write wins.
    let first = request(
        addr,
        "PUT",
        "/api/note/notes/003-a.md",
        &[("If-Match", &shared)],
        "written by the first client",
    )
    .await;
    assert_eq!(first.status, 200);

    // The second is now stale and must be refused, not silently clobber.
    let second = request(
        addr,
        "PUT",
        "/api/note/notes/003-a.md",
        &[("If-Match", &shared)],
        "written by the second client",
    )
    .await;
    assert_eq!(second.status, 409);
    assert_eq!(
        second.headers.get("etag"),
        first.headers.get("etag"),
        "409 must carry the current etag so the client need not re-fetch"
    );

    // The loser's bytes never reached disk.
    let now = request(addr, "GET", "/api/note/notes/003-a.md", &[], "").await;
    assert_eq!(now.body, "written by the first client");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn genuinely_concurrent_puts_yield_one_winner_and_the_rest_409() {
    let tmp = TempVault::new();
    let addr = start(&tmp).await;

    let created = request(addr, "PUT", "/api/note/notes/003-a.md", &[], "seed").await;
    let shared = created.headers.get("etag").expect("etag").clone();

    // The sequential test above proves the etag is *checked*. This one proves
    // the check and the write are atomic: the gap between them spans an fsync,
    // which is wide enough for every one of these to pass a stale check.
    let inflight: Vec<_> = (0..12)
        .map(|n| {
            let shared = shared.clone();
            tokio::spawn(async move {
                let body = format!("writer {n:02} body");
                request(
                    addr,
                    "PUT",
                    "/api/note/notes/003-a.md",
                    &[("If-Match", &shared)],
                    &body,
                )
                .await
                .status
            })
        })
        .collect();

    let mut won = 0;
    let mut lost = 0;
    for task in inflight {
        match task.await.expect("task") {
            200 => won += 1,
            409 => lost += 1,
            other => panic!("unexpected status {other}"),
        }
    }

    assert_eq!(won, 1, "exactly one concurrent writer may win");
    assert_eq!(lost, 11);
}

#[tokio::test]
async fn a_put_without_an_etag_creates() {
    let tmp = TempVault::new();
    let addr = start(&tmp).await;

    let reply = request(addr, "PUT", "/api/note/notes/new.md", &[], "fresh").await;
    assert_eq!(reply.status, 200);
    assert!(tmp.path().join("notes/new.md").is_file());
}

// ---------------------------------------------------------------- deletion

#[tokio::test]
async fn delete_moves_the_note_to_trash() {
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    let addr = start(&tmp).await;

    let reply = request(addr, "DELETE", "/api/note/notes/003-a.md", &[], "").await;
    assert_eq!(reply.status, 204);
    assert!(!tmp.path().join("notes/003-a.md").exists());

    let trashed = std::fs::read_dir(tmp.path().join(".register/trash"))
        .expect("read trash")
        .count();
    assert_eq!(trashed, 1);
}

#[tokio::test]
async fn delete_folder_moves_the_subtree_and_reports_what_left() {
    let tmp = TempVault::new();
    tmp.put("notes/projects/010-a.md", NOTE);
    tmp.put("notes/projects/deep/011-b.md", NOTE);
    tmp.put("notes/projects/diagram.png", "pretend png");
    let addr = start(&tmp).await;

    let reply = request(addr, "DELETE", "/api/folder/notes/projects", &[], "").await;
    assert_eq!(reply.status, 200);
    // The counts are the reason this is not a 204: the client confirmed against
    // two notes and cannot see the PNG, so only the server can say what left.
    assert!(reply.body.contains("\"notes\":2"), "{}", reply.body);
    assert!(reply.body.contains("\"files\":1"), "{}", reply.body);
    assert!(
        reply.body.contains("\".register/trash/"),
        "the bucket is where it went and the notice needs to name it: {}",
        reply.body
    );

    assert!(!tmp.path().join("notes/projects").exists());
    assert_eq!(
        std::fs::read_dir(tmp.path().join(".register/trash"))
            .expect("read trash")
            .count(),
        1
    );
}

#[tokio::test]
async fn the_folder_route_only_deletes() {
    let tmp = TempVault::new();
    tmp.put("notes/projects/010-a.md", NOTE);
    let addr = start(&tmp).await;

    for method in ["GET", "PUT", "POST"] {
        let reply = request(addr, method, "/api/folder/notes/projects", &[], "").await;
        assert_eq!(
            reply.status, 405,
            "{method} /api/folder should not be routed"
        );
    }
    assert!(tmp.path().join("notes/projects/010-a.md").is_file());
}

#[tokio::test]
async fn a_folder_delete_cannot_reach_out_of_the_vault() {
    // The same table `/api/note` and `/api/file` are held to. Each of these
    // names something that exists, so a 404 would prove nothing.
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    tmp.put(".register/config.json", "{}");
    let addr = start(&tmp).await;

    for path in [
        "/api/folder/../..",
        "/api/folder/%2e%2e/%2e%2e",
        "/api/folder/.register",
        "/api/folder/notes/../../etc",
    ] {
        let reply = request(addr, "DELETE", path, &[], "").await;
        assert_eq!(reply.status, 400, "{path} was not refused");
    }
    assert!(tmp.path().join(".register/config.json").is_file());
    assert!(tmp.path().join("notes/003-a.md").is_file());
}

#[tokio::test]
async fn a_note_is_not_a_folder_over_http() {
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    let addr = start(&tmp).await;

    let reply = request(addr, "DELETE", "/api/folder/notes/003-a.md", &[], "").await;
    assert_eq!(reply.status, 404);
    assert!(reply.body.contains("no such folder"), "{}", reply.body);
    assert!(tmp.path().join("notes/003-a.md").is_file());
}

// ---------------------------------------------------------------- security

#[tokio::test]
async fn path_traversal_is_refused() {
    let tmp = TempVault::new();
    let addr = start(&tmp).await;

    // axum percent-decodes into the handler and does no sanitising of its own,
    // so these arrive at vault.rs verbatim. %2e%2e is `..`.
    for hostile in [
        "/api/note/../../../etc/passwd",
        "/api/note/%2e%2e/%2e%2e/etc/passwd",
        "/api/note/.register/config.json",
    ] {
        let reply = request(addr, "GET", hostile, &[], "").await;
        assert!(
            reply.status == 400 || reply.status == 404,
            "{hostile} answered {}",
            reply.status
        );

        let write = request(addr, "PUT", hostile, &[], "owned").await;
        assert_eq!(write.status, 400, "{hostile} was writable");
    }
    assert!(!tmp.path().join("../etc").exists());
}

#[tokio::test]
async fn a_cross_origin_request_is_refused() {
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    let addr = start(&tmp).await;

    let reply = request(
        addr,
        "PUT",
        "/api/note/notes/003-a.md",
        &[("Origin", "https://evil.example")],
        "owned by a web page",
    )
    .await;
    assert_eq!(reply.status, 403);

    let untouched = request(addr, "GET", "/api/note/notes/003-a.md", &[], "").await;
    assert_eq!(untouched.body, NOTE);
}

#[tokio::test]
async fn loopback_origins_are_allowed_so_pnpm_dev_works() {
    let tmp = TempVault::new();
    let addr = start(&tmp).await;

    for origin in [
        "http://localhost:5173",
        "http://127.0.0.1:7777",
        "http://[::1]:7777",
    ] {
        let reply = request(
            addr,
            "PUT",
            "/api/note/notes/003-a.md",
            &[("Origin", origin)],
            "from the dev proxy",
        )
        .await;
        assert_eq!(reply.status, 200, "{origin} should be allowed");
    }
}

#[test]
fn loopback_detection() {
    for allowed in [
        "http://localhost",
        "http://localhost:5173",
        "http://127.0.0.1:7777",
        "https://127.0.0.5:1",
        "http://[::1]:7777",
    ] {
        assert!(is_loopback(allowed), "{allowed} should be loopback");
    }
    for refused in [
        "https://evil.example",
        "http://localhost.evil.example",
        "http://127.0.0.1.evil.example",
        "null",
        "file://",
        "",
    ] {
        assert!(!is_loopback(refused), "{refused} should not be loopback");
    }
}

#[tokio::test]
async fn an_unmatched_api_path_is_404_not_the_spa_shell() {
    let tmp = TempVault::new();
    let addr = start(&tmp).await;

    let reply = request(addr, "GET", "/api/nonsense", &[], "").await;
    assert_eq!(reply.status, 404);
    assert!(!reply.body.contains("<!doctype html>"));
}

// --------------------------------------------------------------- reveal (P5)

#[tokio::test]
async fn reveal_is_refused_when_the_server_is_not_on_loopback() {
    let tmp = TempVault::new();
    let (events, _keep) = broadcast::channel(1);
    // Exactly the shape a `--host 0.0.0.0` deployment produces (P12). The Origin
    // and Host guards can both be satisfied by a forged header; what the
    // listener bound to cannot.
    let state =
        AppState::new(Arc::new(tmp.open()), events).bound_to("0.0.0.0:7777".parse().expect("addr"));

    let bound = listener("127.0.0.1", 0).await.expect("bind");
    let addr = bound.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = serve(bound, state).await;
    });

    let reply = request(addr, "POST", "/api/reveal", &[], "").await;
    assert_eq!(reply.status, 403);
}

#[test]
fn reveal_defaults_to_available_and_follows_the_bind() {
    let tmp = TempVault::new();
    let (events, _keep) = broadcast::channel(1);
    let state = AppState::new(Arc::new(tmp.open()), events);

    // Constructed state is local until told otherwise, and `bound_to` is what
    // decides — so the guard cannot be bypassed by forgetting to call it.
    let loopback = state
        .clone()
        .bound_to("127.0.0.1:7777".parse().expect("addr"));
    let public = state.bound_to("192.168.1.10:7777".parse().expect("addr"));

    assert!(loopback.local);
    assert!(!public.local);
}

#[tokio::test]
async fn a_rebound_host_is_refused_even_with_no_origin() {
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    let addr = start(&tmp).await;

    // DNS rebinding is the case the Origin check cannot see: to the browser the
    // page is same-origin, so it sends NO Origin header at all. The Host names
    // the domain it actually dialled, which is why that is what gets checked.
    for host in [
        "rebind.evil.example",
        "rebind.evil.example:7777",
        "127.0.0.1.evil.example",
        "localhost.evil.example",
    ] {
        let reply = request(addr, "GET", "/api/tree", &[("Host", host)], "").await;
        assert_eq!(reply.status, 403, "{host} should be refused");
    }
}

#[tokio::test]
async fn genuine_loopback_hosts_are_allowed() {
    let tmp = TempVault::new();
    let addr = start(&tmp).await;

    for host in [
        "localhost",
        "localhost:7777",
        "127.0.0.1:7777",
        "[::1]:7777",
    ] {
        let reply = request(addr, "GET", "/api/tree", &[("Host", host)], "").await;
        assert_eq!(reply.status, 200, "{host} should be allowed");
    }
}

// ------------------------------------------------------------ config + fonts

/// A minimal woff2: only the magic number is read, because §03's job here is to
/// refuse things that are not fonts, not to validate glyph tables.
const WOFF2: &str = "wOF2\0\0\0\0licensed bytes";

#[tokio::test]
async fn config_starts_empty_and_round_trips() {
    let tmp = TempVault::new();
    let addr = start(&tmp).await;

    // A vault that has made no choices, not an error.
    let fresh = request(addr, "GET", "/api/config", &[], "").await;
    assert_eq!(fresh.status, 200);
    assert_eq!(fresh.body.trim(), "{}");

    let written = request(
        addr,
        "PUT",
        "/api/config",
        &[],
        r#"{"scheme":"dark","bodyFace":"teletype"}"#,
    )
    .await;
    assert_eq!(written.status, 204);

    let back = request(addr, "GET", "/api/config", &[], "").await;
    assert!(back.body.contains("\"scheme\":\"dark\""), "{}", back.body);
    assert_eq!(
        back.headers.get("content-type").map(String::as_str),
        Some("application/json")
    );

    // It landed where §04 says, inside the directory agents keep out of.
    assert!(tmp.path().join(".register/config.json").is_file());
}

#[tokio::test]
async fn config_that_is_not_json_is_refused() {
    // The browser reads this at boot. Storing something unparseable would break
    // the app on the next load, with nothing on screen to say why.
    let tmp = TempVault::new();
    let addr = start(&tmp).await;

    let reply = request(addr, "PUT", "/api/config", &[], "scheme: dark").await;
    assert_eq!(reply.status, 400);
    assert!(!tmp.path().join(".register/config.json").exists());
}

#[tokio::test]
async fn a_licensed_font_round_trips_and_is_removable() {
    let tmp = TempVault::new();
    let addr = start(&tmp).await;

    let missing = request(addr, "GET", "/api/font", &[], "").await;
    assert_eq!(missing.status, 404);

    let stored = request(addr, "PUT", "/api/font", &[], WOFF2).await;
    assert_eq!(stored.status, 204);
    assert!(tmp.path().join(".register/fonts/licensed.woff2").is_file());

    let served = request(addr, "GET", "/api/font", &[], "").await;
    assert_eq!(served.status, 200);
    assert_eq!(served.body, WOFF2);
    assert_eq!(
        served.headers.get("content-type").map(String::as_str),
        Some("font/woff2")
    );
    // The user's licensed bytes are not something to leave in a cache.
    assert_eq!(
        served.headers.get("cache-control").map(String::as_str),
        Some("no-store")
    );

    let wiped = request(addr, "DELETE", "/api/font", &[], "").await;
    assert_eq!(wiped.status, 204);
    assert_eq!(request(addr, "GET", "/api/font", &[], "").await.status, 404);
    assert!(!tmp.path().join(".register/fonts/licensed.woff2").exists());
}

#[tokio::test]
async fn a_file_that_is_not_a_font_is_refused() {
    let tmp = TempVault::new();
    let addr = start(&tmp).await;

    // A JPEG, renamed. Sniffed by content, never by the name the browser sent.
    let reply = request(addr, "PUT", "/api/font", &[], "\u{ffff}\u{ffd8}not a font").await;
    assert_eq!(reply.status, 415);
    assert!(!tmp.path().join(".register/fonts").exists());
}

#[tokio::test]
async fn loading_a_second_face_leaves_only_one_behind() {
    let tmp = TempVault::new();
    let addr = start(&tmp).await;

    request(addr, "PUT", "/api/font", &[], WOFF2).await;
    // An OTF this time: a different extension, so a careless implementation
    // would leave two files and serve whichever it happened to look for first.
    let otf = "OTTO\0\0\0\0different bytes";
    assert_eq!(
        request(addr, "PUT", "/api/font", &[], otf).await.status,
        204
    );

    assert!(!tmp.path().join(".register/fonts/licensed.woff2").exists());
    assert!(tmp.path().join(".register/fonts/licensed.otf").is_file());
    assert_eq!(request(addr, "GET", "/api/font", &[], "").await.body, otf);
}

#[tokio::test]
async fn a_licensed_font_never_appears_in_the_vault_tree() {
    // §03: the bytes stay inside `.register/`, which the note API cannot see.
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    let addr = start(&tmp).await;

    request(addr, "PUT", "/api/font", &[], WOFF2).await;

    let tree = request(addr, "GET", "/api/tree", &[], "").await;
    assert!(!tree.body.contains("licensed"), "{}", tree.body);
    assert!(!tree.body.contains("font"), "{}", tree.body);
}

// ------------------------------------------------------------- remote mode

#[test]
fn a_token_is_compared_whole_and_in_constant_time() {
    // Length first, then every byte — no early return on the first wrong
    // character. This guards a whole vault over a network, and an early return
    // leaks the token's length and then its content to anyone who can time it.
    assert!(constant_time_eq(b"hunter2", b"hunter2"));
    assert!(!constant_time_eq(b"hunter2", b"hunter3"));
    assert!(!constant_time_eq(b"hunter2", b"hunter22"));
    assert!(!constant_time_eq(b"", b"x"));
    assert!(constant_time_eq(b"", b""));

    // Differences must ACCUMULATE, not cancel. The fold is `acc | (x ^ y)`, and
    // `cargo-mutants` found on its first run that swapping the `|` for a `^`
    // survived every test above: with XOR the accumulator is a parity, so two
    // differing byte-pairs whose deltas match cancel to zero and a wrong token
    // authenticates. Transposed bytes are the cheapest way to produce that —
    // `uhnter…` against `hunter…` differs in exactly two positions by the same
    // delta, and would have been accepted.
    assert!(!constant_time_eq(b"uhnter2xxxxxxxxx", b"hunter2xxxxxxxxx"));
    // Same shape, further apart, so it is the arithmetic being pinned rather
    // than one lucky string.
    assert!(!constant_time_eq(b"abcdefgh", b"badcfehg"));
    assert!(!constant_time_eq(&[0x01, 0x02], &[0x02, 0x01]));
}

#[test]
fn a_token_is_read_from_a_header_a_cookie_or_the_query() {
    let uri: Uri = "/api/tree".parse().expect("uri");
    let with_query: Uri = "/?token=hunter2&x=1".parse().expect("uri");

    let mut bearer_headers = HeaderMap::new();
    bearer_headers.insert(header::AUTHORIZATION, "Bearer hunter2".parse().unwrap());
    assert!(authorised(&bearer_headers, &uri, "hunter2"));

    let mut cookie_headers = HeaderMap::new();
    cookie_headers.insert(
        header::COOKIE,
        "other=1; register_token=hunter2; more=2".parse().unwrap(),
    );
    assert!(authorised(&cookie_headers, &uri, "hunter2"));

    // The query is how the cookie gets set in the first place.
    assert!(authorised(&HeaderMap::new(), &with_query, "hunter2"));

    // And none of them accepts the wrong one, or nothing at all.
    assert!(!authorised(&bearer_headers, &uri, "hunter3"));
    assert!(!authorised(&HeaderMap::new(), &uri, "hunter2"));
}

#[tokio::test]
async fn without_a_token_nothing_is_guarded() {
    // The default, and the whole local experience: no token, no gate.
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    let addr = start_with(&tmp, None).await;

    assert_eq!(request(addr, "GET", "/api/tree", &[], "").await.status, 200);
}

#[tokio::test]
async fn localhost_stays_tokenless_even_in_remote_mode() {
    // §08 P12, verbatim. A request that reached 127.0.0.1 came from this
    // machine, where the vault's files are readable anyway.
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    let addr = start_with(&tmp, Some("hunter2")).await;

    let reply = request(addr, "GET", "/api/tree", &[], "").await;
    assert_eq!(reply.status, 200, "loopback was asked for a token");
    assert!(reply.body.contains("003-a.md"));
}

#[tokio::test]
async fn an_empty_token_is_a_mistake_not_a_secret() {
    // `--token ""` must not read as "remote mode is on and lets everyone in".
    let tmp = TempVault::new();
    let vault = Arc::new(tmp.open());
    let (events, _keep) = broadcast::channel(64);

    assert!(
        !AppState::new(vault.clone(), events.clone())
            .with_token(Some(String::new()))
            .guarded()
    );
    assert!(
        AppState::new(vault, events)
            .with_token(Some("hunter2".to_owned()))
            .guarded()
    );
}

/// Every combination of the rule §08 P12 states, including the one a unit test
/// cannot otherwise reach: a peer that is not this machine.
#[test]
fn a_tokenless_remote_request_is_refused_and_localhost_is_not() {
    let plain: Uri = "/api/tree".parse().expect("uri");
    let carrying: Uri = "/?token=hunter2".parse().expect("uri");
    let wrong_query: Uri = "/?token=guess".parse().expect("uri");

    let none = HeaderMap::new();
    let mut bearer = HeaderMap::new();
    bearer.insert(header::AUTHORIZATION, "Bearer hunter2".parse().unwrap());
    let mut cookie = HeaderMap::new();
    cookie.insert(header::COOKIE, "register_token=hunter2".parse().unwrap());
    let mut wrong = HeaderMap::new();
    wrong.insert(header::AUTHORIZATION, "Bearer guess".parse().unwrap());

    const REMOTE: bool = false;
    const LOCAL: bool = true;

    for (label, expected, peer, headers, uri, want) in [
        // No token configured: the default, and nothing is guarded.
        ("no token, remote", None, REMOTE, &none, &plain, Gate::Allow),
        ("no token, local", None, LOCAL, &none, &plain, Gate::Allow),
        // Configured: localhost is exempt, whatever it sends.
        (
            "token, local",
            Some("hunter2"),
            LOCAL,
            &none,
            &plain,
            Gate::Allow,
        ),
        // …and a stranger is not. This is the clause.
        (
            "token, remote, nothing",
            Some("hunter2"),
            REMOTE,
            &none,
            &plain,
            Gate::Refuse,
        ),
        (
            "token, remote, wrong header",
            Some("hunter2"),
            REMOTE,
            &wrong,
            &plain,
            Gate::Refuse,
        ),
        (
            "token, remote, wrong query",
            Some("hunter2"),
            REMOTE,
            &none,
            &wrong_query,
            Gate::Refuse,
        ),
        // Presented properly, three ways.
        (
            "token, remote, bearer",
            Some("hunter2"),
            REMOTE,
            &bearer,
            &plain,
            Gate::Authenticated,
        ),
        (
            "token, remote, cookie",
            Some("hunter2"),
            REMOTE,
            &cookie,
            &plain,
            Gate::Authenticated,
        ),
        (
            "token, remote, query",
            Some("hunter2"),
            REMOTE,
            &none,
            &carrying,
            // Remembered, because the WebSocket that follows can send no header.
            Gate::AuthenticatedAndRemember,
        ),
    ] {
        assert_eq!(decide(expected, peer, headers, uri), want, "{label}");
    }
}

/// The Host and Origin rules are waived for one reason only: the request proved
/// it holds the token. This pins who earns that waiver.
///
/// It is the composition that broke. `decide` was always right; the gate then
/// ignored it and set the marker from the peer address alone — `!peer_is_loopback`
/// — so on a `--host 0.0.0.0` bind with **no token configured at all**, every
/// stranger on the network was handed the exemption and could drive the API
/// from any origin, WebSocket included. The tokenless-remote row below is that
/// bug; it fails against the old code.
#[test]
fn only_a_presented_token_waives_the_host_rule() {
    let plain: Uri = "/api/tree".parse().expect("uri");
    let carrying: Uri = "/?token=hunter2".parse().expect("uri");
    let none = HeaderMap::new();
    let mut bearer = HeaderMap::new();
    bearer.insert(header::AUTHORIZATION, "Bearer hunter2".parse().unwrap());

    const REMOTE: bool = false;
    const LOCAL: bool = true;

    for (label, expected, peer, headers, uri, waived) in [
        // The bug. No token configured, so nothing was ever asked for and
        // nothing can have been proved — whoever the peer is.
        ("no token, remote peer", None, REMOTE, &none, &plain, false),
        ("no token, local peer", None, LOCAL, &none, &plain, false),
        // Exempt from the token by §08 P12, but not from the Host rule: a
        // rebinding attack runs as a loopback peer, which is the whole point.
        (
            "token, local peer",
            Some("hunter2"),
            LOCAL,
            &none,
            &plain,
            false,
        ),
        // Refused outright, so there is nothing to waive.
        (
            "token, remote, none",
            Some("hunter2"),
            REMOTE,
            &none,
            &plain,
            false,
        ),
        // Earned it.
        (
            "token, remote, bearer",
            Some("hunter2"),
            REMOTE,
            &bearer,
            &plain,
            true,
        ),
        (
            "token, remote, query",
            Some("hunter2"),
            REMOTE,
            &none,
            &carrying,
            true,
        ),
    ] {
        // Through `earned_by`, not `proved_the_token`, because that is the call
        // the gate itself makes — testing the rule without testing its use is
        // how the original bug survived a green suite.
        let mark = super::Authenticated::earned_by(decide(expected, peer, headers, uri));
        assert_eq!(mark.is_some(), waived, "{label}");
    }
}

/// The bug, on the wire: a stranger reaching a **tokenless** bind used to be
/// handed the waiver meant for someone who presented a credential, because the
/// gate keyed it off the peer address alone.
///
/// That is the `--host 0.0.0.0` shape `deploy/Dockerfile` ships, so it was not
/// hypothetical. The unit test above proves the rule; this proves the gate
/// obeys it, which is the half that was broken.
#[tokio::test]
async fn a_stranger_on_a_tokenless_bind_keeps_the_host_and_origin_rules() {
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    let addr = start_as_stranger(&tmp, None).await;

    // Sanity first: this server does answer, so the refusals below mean the
    // guards fired rather than that nothing is listening.
    let ok = request(addr, "GET", "/api/tree", &[], "").await;
    assert_eq!(
        ok.status, 200,
        "the stranger server refused a plain request"
    );

    let rebound = request(addr, "GET", "/api/tree", &[("Host", "evil.example")], "").await;
    assert_eq!(rebound.status, 403, "a stranger was waived the Host rule");

    let cross = request(
        addr,
        "GET",
        "/api/tree",
        &[("Origin", "https://evil.example")],
        "",
    )
    .await;
    assert_eq!(cross.status, 403, "a stranger was waived the Origin rule");

    // The event stream matters most: a WebSocket is not bound by CORS, so it is
    // the one route a hostile page could read from even without the response
    // headers a `fetch` needs.
    assert_eq!(
        upgrade(addr, "/api/events", &[("Origin", "https://evil.example")]).await,
        403,
        "a hostile origin opened the event stream"
    );
    // And the same handshake without the hostile origin does open, so the 403
    // above is the guard refusing rather than the handshake being malformed.
    assert_eq!(
        upgrade(addr, "/api/events", &[]).await,
        101,
        "the event stream never opens, so the refusal above proves nothing"
    );

    // And a stranger who *does* hold the token still gets in, so the fix did
    // not simply close remote mode.
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    let guarded = start_as_stranger(&tmp, Some("hunter2")).await;
    let carrying = request(
        guarded,
        "GET",
        "/api/tree",
        &[
            ("Host", "vault.example"),
            ("Authorization", "Bearer hunter2"),
        ],
        "",
    )
    .await;
    assert_eq!(
        carrying.status, 200,
        "remote mode stopped working for a valid token"
    );
}

#[test]
fn stripping_the_token_leaves_the_rest_of_the_query_alone() {
    for (before, after) in [
        ("/?token=abc", "/"),
        ("/index.html?token=abc", "/index.html"),
        ("/?token=abc&q=1", "/?q=1"),
        ("/?q=1&token=abc", "/?q=1"),
        ("/?q=1&token=abc&r=2", "/?q=1&r=2"),
        // A value that merely contains the word survives untouched.
        ("/?q=token=notmine", "/?q=token=notmine"),
        ("/?q=1", "/?q=1"),
        ("/", "/"),
        // Repeated, both dropped.
        ("/?token=a&token=b", "/"),
        // This string becomes a `Location`, and `//host/` is a scheme-relative
        // URL rather than a path — the browser would leave this origin. Measured
        // before the fix: `location: //evil.example/`. Backslash is the same
        // hole, because browsers normalise it to a slash.
        ("//evil.example/?token=abc", "/evil.example/"),
        ("////evil.example/?token=abc", "/evil.example/"),
        ("/\\evil.example?token=abc", "/evil.example"),
        ("//evil.example/?token=abc&q=1", "/evil.example/?q=1"),
    ] {
        let uri: Uri = before.parse().expect("uri");
        let after_it = without_token(&uri);
        assert_eq!(after_it, after, "{before}");
        // The property behind those last four, stated once: whatever comes out
        // is a same-origin path. One leading slash, and never two.
        assert!(after_it.starts_with('/'), "{before} -> {after_it}");
        assert!(
            !after_it.starts_with("//") && !after_it.starts_with("/\\"),
            "{before} -> {after_it} is scheme-relative, so it leaves the origin"
        );
    }
}

/// §08 P12 hands back a cookie so the token need only be presented once. It was
/// still sitting in the address bar afterwards — kept in history, in a bookmark,
/// and in the `Referer` of every outbound link. Now the page redirects to itself
/// without it.
#[tokio::test]
async fn the_token_does_not_stay_in_the_address_bar() {
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    let addr = start_as_stranger(&tmp, Some("hunter2")).await;

    let opened = request(addr, "GET", "/?token=hunter2", &[], "").await;
    assert_eq!(opened.status, 303, "the token stayed in the URL");
    assert_eq!(
        opened.headers.get("location").map(String::as_str),
        Some("/"),
        "redirected somewhere other than the same page"
    );
    // The redirect is only worth anything if the cookie went with it.
    let cookie = opened.headers.get("set-cookie").expect("no cookie issued");
    assert!(cookie.contains("register_token=hunter2"), "{cookie}");
    assert!(cookie.contains("HttpOnly"), "{cookie}");
    assert!(cookie.contains("SameSite=Strict"), "{cookie}");

    // A WebSocket cannot follow a redirect, and `?token=` is how it
    // authenticates before any cookie exists — so it must not be redirected.
    let socket = upgrade(addr, "/api/events?token=hunter2", &[]).await;
    assert_ne!(socket, 303, "the event stream was redirected");
    assert_eq!(socket, 101, "the event stream did not open");

    // Nor is an API read a navigation. `GET /api/tree?token=…` is an ordinary
    // way for a script to read the vault, and answering 303 hands back a
    // redirect instead of the JSON it asked for. Only the address bar needed
    // cleaning, and only a document has one.
    let api = request(addr, "GET", "/api/tree?token=hunter2", &[], "").await;
    assert_eq!(api.status, 200, "an API read was redirected");
    assert!(api.body.contains("\"notes\""), "{}", api.body);
}

#[tokio::test]
async fn remote_mode_does_not_reopen_the_rebinding_hole() {
    // The live check that found this: a valid token used to be answered 403,
    // because the Host rule from P2 demands loopback and remote mode by
    // definition is not. Authenticating now bypasses that rule — so this pins
    // that the rule still holds for everyone who has *not* authenticated,
    // which is exactly who a rebinding attack runs as.
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    let addr = start_with(&tmp, Some("hunter2")).await;

    // A loopback peer is exempt from the token, and still may not be reached
    // through a rebound name.
    let rebound = request(addr, "GET", "/api/tree", &[("Host", "evil.example")], "").await;
    assert_eq!(rebound.status, 403, "a rebound Host was allowed through");

    // …even while carrying the token, because a rebinding attack cannot obtain
    // it but could be handed one by a careless user.
    let rebound_with_token = request(
        addr,
        "GET",
        "/api/tree",
        &[
            ("Host", "evil.example"),
            ("Authorization", "Bearer hunter2"),
        ],
        "",
    )
    .await;
    assert_eq!(
        rebound_with_token.status, 403,
        "loopback + a token skipped the Host rule"
    );
}

// ------------------------------------------------------------ --assets (dev)

/// A built-UI-shaped directory, plus a secret beside it to try to reach.
fn ui_dir() -> (TempVault, std::path::PathBuf) {
    let tmp = TempVault::new();
    let dist = tmp.path().join("dist");
    fs::create_dir_all(dist.join("assets")).expect("create dist");
    fs::write(dist.join("index.html"), "<html>from disk</html>").expect("index");
    fs::write(dist.join("assets/app.css"), ".from{disk:1}").expect("css");
    fs::write(tmp.path().join("secret.txt"), "not for the web").expect("secret");
    (tmp, dist)
}

async fn start_serving(tmp: &TempVault, dist: &std::path::Path) -> SocketAddr {
    let vault = Arc::new(tmp.open());
    let (events, _keep) = broadcast::channel(64);
    let state = AppState::new(vault, events).with_assets(Some(dist.to_path_buf()));

    let bound = listener("127.0.0.1", 0).await.expect("bind");
    let addr = bound.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = serve(bound, state).await;
    });
    addr
}

#[tokio::test]
async fn assets_are_served_from_disk_when_asked() {
    // The point of the flag: a `pnpm build` is enough, with no reinstall. A
    // stale embedded UI looks exactly like a fix that did not work, which cost
    // real time before this existed.
    let (tmp, dist) = ui_dir();
    let addr = start_serving(&tmp, &dist).await;

    let shell = request(addr, "GET", "/", &[], "").await;
    assert_eq!(shell.status, 200);
    assert_eq!(shell.body, "<html>from disk</html>");

    let css = request(addr, "GET", "/assets/app.css", &[], "").await;
    assert_eq!(css.status, 200);
    assert_eq!(css.body, ".from{disk:1}");
    assert_eq!(
        css.headers.get("content-type").map(String::as_str),
        Some("text/css; charset=utf-8")
    );
}

#[tokio::test]
async fn a_disk_asset_path_cannot_escape_the_directory() {
    // The request path is the caller's, so it gets what a note path gets.
    let (tmp, dist) = ui_dir();
    let addr = start_serving(&tmp, &dist).await;

    for escape in [
        "/../secret.txt",
        "/assets/../../secret.txt",
        "/..%2fsecret.txt",
        "/./../secret.txt",
    ] {
        let reply = request(addr, "GET", escape, &[], "").await;
        assert!(
            !reply.body.contains("not for the web"),
            "{escape} escaped the assets directory"
        );
    }
}

// Gated whole. With `#[cfg(unix)]` on the symlink call alone, this ran on
// Windows against a link that was never created and asserted that a file which
// does not exist did not leak — green, and measuring nothing.
#[cfg(unix)]
#[tokio::test]
async fn a_symlink_out_of_the_assets_directory_is_refused() {
    // Lexical checks cannot see this one: every path component is ordinary.
    let (tmp, dist) = ui_dir();
    std::os::unix::fs::symlink(tmp.path().join("secret.txt"), dist.join("leak.txt"))
        .expect("symlink");
    let addr = start_serving(&tmp, &dist).await;

    // Positive control: the link really does point at readable bytes, so the
    // refusal below is the guard working rather than a broken fixture.
    assert!(
        std::fs::read_to_string(dist.join("leak.txt"))
            .expect("the symlink should resolve on disk")
            .contains("not for the web"),
        "the fixture never linked anything, so nothing was tested"
    );

    let reply = request(addr, "GET", "/leak.txt", &[], "").await;
    assert!(
        !reply.body.contains("not for the web"),
        "a symlink walked out of the assets directory"
    );
}

#[tokio::test]
async fn an_unknown_route_still_gets_the_shell_and_an_api_path_still_does_not() {
    // Same two rules as the embedded path: the client owns routing, and an
    // unmatched /api/* is a routing mistake rather than a page.
    let (tmp, dist) = ui_dir();
    let addr = start_serving(&tmp, &dist).await;

    let route = request(addr, "GET", "/some/client/route", &[], "").await;
    assert_eq!(route.status, 200);
    assert_eq!(route.body, "<html>from disk</html>");

    let missing = request(addr, "GET", "/api/nope", &[], "").await;
    assert_eq!(missing.status, 404);
    assert!(missing.body.contains("no such endpoint"));
}

#[test]
fn the_policy_names_this_origins_socket_and_nothing_else() {
    let with = |host: &str| {
        let mut headers = HeaderMap::new();
        if let Ok(value) = host.parse() {
            headers.insert(header::HOST, value);
        }
        socket_origin(&headers)
    };

    // The ordinary shapes, including IPv6 in brackets and a bare name.
    assert_eq!(
        with("127.0.0.1:7777"),
        " ws://127.0.0.1:7777 wss://127.0.0.1:7777"
    );
    assert_eq!(with("localhost"), " ws://localhost wss://localhost");
    assert_eq!(with("[::1]:7777"), " ws://[::1]:7777 wss://[::1]:7777");
    assert_eq!(
        with("vault.tail1234.ts.net"),
        " ws://vault.tail1234.ts.net wss://vault.tail1234.ts.net"
    );

    // Anything that could end the directive and start another is dropped whole,
    // rather than escaped — there is no escaping in CSP, and a header this
    // strange is not a request worth accommodating.
    for hostile in [
        "evil;script-src *",
        "evil' 'unsafe-inline",
        "evil example",
        "evil\tx",
        "",
    ] {
        assert_eq!(with(hostile), "", "{hostile:?} reached the policy");
    }

    // No Host at all: fall back to `'self'` alone rather than to a broken policy.
    assert_eq!(socket_origin(&HeaderMap::new()), "");
}

/// `GET /api/file` over the wire: the status codes and headers a browser acts
/// on, which the vault-level tests cannot see.
mod file_endpoint {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";

    fn put_bytes(tmp: &TempVault, rel: &str, bytes: &[u8]) {
        let path = tmp.path().join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("create dir");
        std::fs::write(path, bytes).expect("write bytes");
    }

    #[tokio::test]
    async fn serves_an_image_with_its_sniffed_type_and_an_etag() {
        let tmp = TempVault::new();
        put_bytes(&tmp, "notes/diagram.png", PNG);
        let addr = start(&tmp).await;

        let reply = request(addr, "GET", "/api/file/notes/diagram.png", &[], "").await;
        assert_eq!(reply.status, 200);
        // `nosniff` is on every response, so this header is the whole difference
        // between rendering and not rendering.
        assert_eq!(
            reply.headers.get("content-type").map(String::as_str),
            Some("image/png")
        );
        let etag = reply.headers.get("etag").cloned().expect("etag");
        assert!(
            etag.starts_with('"') && etag.ends_with('"'),
            "{etag} is not quoted"
        );

        // And the conditional request the etag exists for.
        let again = request(
            addr,
            "GET",
            "/api/file/notes/diagram.png",
            &[("If-None-Match", etag.as_str())],
            "",
        )
        .await;
        assert_eq!(
            again.status, 304,
            "a matching etag should not resend the file"
        );
        assert!(again.body.is_empty(), "304 must carry no body");
    }

    #[tokio::test]
    async fn a_note_is_not_a_file_this_endpoint_will_serve() {
        // The mirror of `only_markdown_is_a_note`: the two halves of the API
        // refuse each other's content, so neither can be used to reach the
        // other's rules.
        let tmp = TempVault::new();
        tmp.put("notes/003-a.md", "---\nref: 003\n---\nBody.\n");
        put_bytes(
            &tmp,
            "notes/trick.png",
            b"---\nref: 004\n---\nstill markdown\n",
        );
        let addr = start(&tmp).await;

        for path in ["/api/file/notes/003-a.md", "/api/file/notes/trick.png"] {
            let reply = request(addr, "GET", path, &[], "").await;
            assert_eq!(reply.status, 415, "{path} answered {}", reply.status);
        }
    }

    #[tokio::test]
    async fn path_traversal_is_refused_here_too() {
        let tmp = TempVault::new();
        let addr = start(&tmp).await;

        for hostile in [
            "/api/file/../../../etc/passwd",
            "/api/file/%2e%2e/%2e%2e/etc/passwd",
            "/api/file/.register/config.json",
            "/api/file/.register/fonts/licensed.woff2",
        ] {
            let reply = request(addr, "GET", hostile, &[], "").await;
            assert!(
                reply.status == 400 || reply.status == 404,
                "{hostile} answered {}",
                reply.status
            );
        }
    }

    #[tokio::test]
    async fn the_endpoint_is_read_only() {
        // Nothing may create a file the tree will never show. If this ever
        // answers 200, `resolve`'s one definition of a note has been bypassed.
        let tmp = TempVault::new();
        put_bytes(&tmp, "notes/diagram.png", PNG);
        let addr = start(&tmp).await;

        // No body: axum answers 405 and closes without consuming one, which
        // resets the connection under the test client rather than failing the
        // assertion — a broken probe reading as a broken server.
        for method in ["PUT", "DELETE", "POST"] {
            let reply = request(addr, method, "/api/file/notes/diagram.png", &[], "").await;
            assert_eq!(reply.status, 405, "{method} /api/file should not be routed");
        }
    }

    #[tokio::test]
    async fn a_missing_file_is_404() {
        let tmp = TempVault::new();
        let addr = start(&tmp).await;
        let reply = request(addr, "GET", "/api/file/notes/absent.png", &[], "").await;
        assert_eq!(reply.status, 404);
    }
}
