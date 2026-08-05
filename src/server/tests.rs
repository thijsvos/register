use std::collections::HashMap;
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

    // `Connection: close` lets read_to_end terminate without parsing lengths.
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (name, value) in extra {
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
    let vault = Arc::new(tmp.open());
    let (events, _keep) = broadcast::channel(64);
    let state = AppState::new(vault, events);

    let bound = listener("127.0.0.1", 0).await.expect("bind");
    let addr = bound.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = serve(bound, state).await;
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
