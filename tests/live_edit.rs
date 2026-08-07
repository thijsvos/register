//! §08 P8's acceptance: an agent edits the files, the UI sees it.
//!
//! Black box on purpose. This drives the shipped binary — `register init`,
//! `register new`, `register serve` — and speaks HTTP and WebSocket over raw
//! sockets, because what P8 has to prove is that a vault written by ordinary
//! file tools reaches a connected client inside §06's budget. A test that
//! reached into the crate's own types could not tell you that.
//!
//! P9's BYOF acceptance rides along here for the same reason: "git status stays
//! clean" is a claim about the shipped binary and a real repository, and nothing
//! smaller than both can check it.
//!
//! Not covered: the browser half. "The UI shows it" ends here at the frame the
//! UI is listening for; asserting the pixel needs Playwright, and rule 6 puts a
//! new dependency behind an ADR and an approval. Recorded in docs/ROADMAP.md.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// §06: "Agent edit → visible in UI ≤ 100 ms".
const BUDGET: Duration = Duration::from_millis(100);
/// Long enough that a loaded CI box does not fail on scheduling noise; short
/// enough that a genuinely broken watcher fails rather than hangs.
const PATIENCE: Duration = Duration::from_secs(5);

const BINARY: &str = env!("CARGO_BIN_EXE_register");

// ------------------------------------------------------------------ scaffolding

fn scratch(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("register-e2e-{name}-{nanos:x}"));
    std::fs::create_dir_all(&path).expect("create scratch");
    path.canonicalize().expect("canonicalize scratch")
}

/// Run the binary and return its stdout, failing loudly with stderr.
fn register(args: &[&str], cwd: &Path) -> String {
    let out = Command::new(BINARY)
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("run register");
    assert!(
        out.status.success(),
        "register {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Run a shell command in the vault — the way an agent actually edits files.
fn shell(script: &str, cwd: &Path) {
    let status = Command::new("sh")
        .arg("-c")
        .arg(script)
        .current_dir(cwd)
        .status()
        .expect("run sh");
    assert!(status.success(), "shell failed: {script}");
}

/// A server on an ephemeral port. Killed when the guard drops, so a failing
/// assertion cannot leave a process holding the vault.
struct Server {
    child: Child,
    addr: String,
}

impl Server {
    fn start(vault: &Path) -> Self {
        let mut child = Command::new(BINARY)
            .args(["serve", vault.to_str().expect("utf-8 path"), "--port", "0"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn server");

        // The banner names the address it actually bound, which is the only way
        // to learn an ephemeral port.
        let stdout = child.stdout.take().expect("piped stdout");
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .expect("read banner");
        let addr = line
            .rsplit_once("http://")
            .map(|(_, rest)| rest.trim().to_owned())
            .unwrap_or_else(|| panic!("no address in banner: {line:?}"));

        Self { child, addr }
    }

    fn connect(&self) -> TcpStream {
        let stream = TcpStream::connect(&self.addr).expect("connect");
        stream
            .set_read_timeout(Some(PATIENCE))
            .expect("set timeout");
        stream
    }

    fn get(&self, path: &str) -> String {
        let mut stream = self.connect();
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
            self.addr
        );
        stream.write_all(request.as_bytes()).expect("write request");
        let mut raw = String::new();
        stream.read_to_string(&mut raw).expect("read response");
        raw.split_once("\r\n\r\n")
            .map(|(_, body)| body.to_owned())
            .unwrap_or_default()
    }

    /// A WebSocket on `/api/events`, handshake done.
    fn events(&self) -> TcpStream {
        let mut stream = self.connect();
        // The key is RFC 6455's own example. The server's Accept is not checked
        // back: verifying it needs SHA-1, and what this test is about is the
        // frames, not the handshake's arithmetic.
        let request = format!(
            "GET /api/events HTTP/1.1\r\n\
             Host: {}\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             Sec-WebSocket-Version: 13\r\n\r\n",
            self.addr
        );
        stream.write_all(request.as_bytes()).expect("write upgrade");

        // Read exactly the headers, byte by byte: anything more would swallow
        // the first frame, which is the one being timed.
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).expect("read handshake");
            head.push(byte[0]);
        }
        let head = String::from_utf8_lossy(&head).into_owned();
        assert!(
            head.starts_with("HTTP/1.1 101"),
            "upgrade refused: {}",
            head.lines().next().unwrap_or_default()
        );
        stream
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One text frame from the server. Server frames are never masked (RFC 6455).
fn next_frame(stream: &mut TcpStream) -> String {
    loop {
        let mut header = [0u8; 2];
        stream.read_exact(&mut header).expect("read frame header");
        let opcode = header[0] & 0x0f;

        let short = usize::from(header[1] & 0x7f);
        let length = match short {
            126 => {
                let mut wide = [0u8; 2];
                stream.read_exact(&mut wide).expect("read length");
                usize::from(u16::from_be_bytes(wide))
            }
            127 => {
                let mut wide = [0u8; 8];
                stream.read_exact(&mut wide).expect("read length");
                u64::from_be_bytes(wide) as usize
            }
            other => other,
        };

        let mut payload = vec![0u8; length];
        stream.read_exact(&mut payload).expect("read payload");

        // 1 is text; ping/pong and close are skipped rather than mistaken for
        // an event frame.
        if opcode == 1 {
            return String::from_utf8_lossy(&payload).into_owned();
        }
        assert_ne!(opcode, 8, "server closed the socket");
    }
}

// ------------------------------------------------------------------------ tests

#[test]
fn a_fresh_vault_is_one_command_and_the_cli_fills_it() {
    let root = scratch("init");
    let vault = root.join("vault");

    let said = register(&["init", vault.to_str().expect("utf-8")], &root);
    assert!(said.contains("+ CLAUDE.md"), "init was quiet: {said}");
    assert!(
        said.contains("next: register serve"),
        "no next step: {said}"
    );

    // §04's layout, on disk.
    for rel in [
        "CLAUDE.md",
        "000-inbox.md",
        "templates/daily.md",
        ".register/config.json",
    ] {
        assert!(vault.join(rel).is_file(), "missing {rel}");
    }
    for rel in ["notes", "daily", "templates", ".register/trash"] {
        assert!(vault.join(rel).is_dir(), "missing {rel}/");
    }

    // The contract an agent will read.
    let contract = std::fs::read_to_string(vault.join("CLAUDE.md")).expect("read contract");
    assert!(contract.starts_with("# This folder is a REGISTER vault — agent contract"));
    assert!(contract.contains("[[Title]] or [[NNN]]  wikilink"));

    let printed = register(&["new", "Terminal aesthetics"], &vault);
    assert_eq!(printed.trim(), "notes/001-terminal-aesthetics.md");
    assert!(vault.join(printed.trim()).is_file());
}

#[test]
fn new_refuses_outside_a_vault_rather_than_scattering_notes() {
    let root = scratch("stray");
    let out = Command::new(BINARY)
        .args(["new", "Nowhere"])
        .current_dir(&root)
        .output()
        .expect("run register");

    assert!(!out.status.success());
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(said.contains("not a REGISTER vault"), "unhelpful: {said}");
    assert!(said.contains("register init"), "no next step: {said}");
    assert!(!root.join("notes").exists(), "it wrote anyway");
}

#[test]
fn an_agents_append_reaches_a_connected_client_inside_the_budget() {
    let root = scratch("append");
    let vault = root.join("vault");
    register(&["init", vault.to_str().expect("utf-8")], &root);
    register(&["new", "Terminal aesthetics"], &vault);

    let server = Server::start(&vault);
    let mut socket = server.events();

    // The watcher debounces at 50 ms from the first event of a burst, so the
    // clock starts once the write has actually landed on disk.
    shell(
        "printf '%s\\n' '- [ ] written from a terminal' >> notes/001-terminal-aesthetics.md",
        &vault,
    );
    let started = Instant::now();
    let frame = next_frame(&mut socket);
    let took = started.elapsed();

    assert!(
        frame.contains("notes/001-terminal-aesthetics.md"),
        "wrong note in frame: {frame}"
    );
    assert!(
        frame.contains("\"type\":\"changed\"") || frame.contains("\"type\":\"created\""),
        "unexpected frame: {frame}"
    );
    assert!(
        took < BUDGET,
        "§06 budgets 100 ms from an agent's write to the repaint; the frame took {took:?}"
    );
}

#[test]
fn a_note_created_by_the_cli_appears_in_the_tree_the_sidebar_reads() {
    let root = scratch("sidebar");
    let vault = root.join("vault");
    register(&["init", vault.to_str().expect("utf-8")], &root);

    let server = Server::start(&vault);
    let mut socket = server.events();

    let created = register(&["new", "Perf doctrine"], &vault);
    let created = created.trim();
    let frame = next_frame(&mut socket);
    assert!(frame.contains(created), "not announced: {frame}");

    // The sidebar is built from /api/tree, so that is what "appears in the
    // sidebar" means on this side of the browser.
    let tree = server.get("/api/tree");
    assert!(tree.contains(created), "not in the tree: {tree}");
    assert!(
        tree.contains("\"title\":\"Perf doctrine\""),
        "the tree could not parse what the CLI wrote: {tree}"
    );
    assert!(
        tree.contains("\"ref\":\"001\""),
        "ref missing from the tree: {tree}"
    );
}

#[test]
fn a_note_written_by_hand_is_read_back_as_a_note() {
    // P8's acceptance is a *fresh agent* writing a conforming note from the
    // contract alone. This is that note, typed out by hand exactly as
    // CLAUDE.md describes it, and read back through the API the UI uses.
    let root = scratch("byhand");
    let vault = root.join("vault");
    register(&["init", vault.to_str().expect("utf-8")], &root);

    let server = Server::start(&vault);

    shell(
        "cat > notes/001-crdt-reading.md <<'EOF'\n\
---\n\
id: 01J2ZK7Q8W3E5R9TQZ8XV2M4KD\n\
ref: 001\n\
title: CRDT reading\n\
created: 2026-08-05\n\
modified: 2026-08-05T09:16:40Z\n\
tags: [research, reading]\n\
---\n\
See [[Inbox]] and [[000]].\n\
\n\
- [ ] finish the Kleppmann paper\n\
EOF",
        &vault,
    );

    // Poll rather than sleep: the watcher debounces, and a fixed wait would
    // either be flaky or slower than it needs to be.
    let deadline = Instant::now() + PATIENCE;
    let tree = loop {
        let tree = server.get("/api/tree");
        if tree.contains("CRDT reading") || Instant::now() > deadline {
            break tree;
        }
        std::thread::sleep(Duration::from_millis(10));
    };

    assert!(tree.contains("\"title\":\"CRDT reading\""), "{tree}");
    assert!(tree.contains("\"ref\":\"001\""), "{tree}");
    assert!(tree.contains("\"research\""), "tags not parsed: {tree}");

    // And the ref it used is not handed out again.
    let next = register(&["new", "After"], &vault);
    assert_eq!(next.trim(), "notes/002-after.md");
}

/// A woff2 as far as anything here is concerned: the server sniffs the first
/// four bytes and refuses what is not a font, and licensed bytes are exactly
/// what must never appear in this repository (§03).
const FONT: &[u8] = b"wOF2\x00\x00\x00\x00pretend licensed face";

fn put_font(server: &Server, bytes: &[u8]) -> u16 {
    let mut stream = server.connect();
    let head = format!(
        "PUT /api/font HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        server.addr,
        bytes.len()
    );
    stream.write_all(head.as_bytes()).expect("write head");
    stream.write_all(bytes).expect("write body");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).expect("read");
    raw.split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0)
}

fn git(args: &[&str], cwd: &Path) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("run git");
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn a_licensed_font_never_reaches_the_repository() {
    // §08 P9's acceptance, and §03's legal position: a commercial face lives in
    // the vault the user licensed it for and nowhere a `git push` can take it.
    let root = scratch("byof");
    let vault = root.join("vault");
    register(&["init", vault.to_str().expect("utf-8"), "--git"], &root);

    // A clean starting point, so what the font does is the only variable.
    // `init --git` commits the scaffold itself now, so this only has to cover
    // the machine where that could not happen — no configured identity, which
    // is exactly what CI looks like until something sets one.
    shell(
        "git add -A && git diff --cached --quiet \
         || git -c user.email=t@e -c user.name=T commit -qm init",
        &vault,
    );
    assert_eq!(git(&["status", "--porcelain"], &vault), "");

    let server = Server::start(&vault);
    assert_eq!(put_font(&server, FONT), 204);

    // The bytes are on disk, in the vault, ready to serve.
    assert!(vault.join(".register/fonts/licensed.woff2").is_file());
    assert_eq!(
        std::fs::read(vault.join(".register/fonts/licensed.woff2")).expect("read"),
        FONT
    );

    // And git has nothing to say about them.
    let dirty = git(&["status", "--porcelain"], &vault);
    assert_eq!(dirty, "", "loading a font dirtied the repo:\n{dirty}");

    let tracked = git(&["ls-files"], &vault);
    assert!(
        !tracked.contains("fonts"),
        "a font path is tracked:\n{tracked}"
    );

    // Config is a different case, deliberately. §08 P8 names two paths to
    // ignore — fonts and trash — and config.json is neither: your scheme and
    // body face are vault state, so changing one shows up as a modification.
    // Pinned here so the distinction stays a decision rather than an accident.
    let mut stream = server.connect();
    let body = r#"{"scheme":"dark","bodyFace":"default"}"#;
    let head = format!(
        "PUT /api/config HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        server.addr,
        body.len()
    );
    stream.write_all(head.as_bytes()).expect("write");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).expect("read");

    let after = git(&["status", "--porcelain"], &vault);
    assert!(
        after.contains(".register/config.json"),
        "a setting should be a tracked change:\n{after}"
    );
    assert!(
        !after.contains("fonts"),
        "the font still must not be:\n{after}"
    );
}

#[test]
fn a_file_that_is_not_a_font_is_refused_by_the_binary() {
    let root = scratch("notfont");
    let vault = root.join("vault");
    register(&["init", vault.to_str().expect("utf-8")], &root);

    let server = Server::start(&vault);
    // Sniffed by content: the name a browser reports is a user-supplied string.
    assert_eq!(put_font(&server, b"\x89PNG\r\n\x1a\n not a font"), 415);
    // `register init` creates the directory as part of §04's tree, so the check
    // is that it stayed empty — not that it never existed.
    let stored: Vec<_> = std::fs::read_dir(vault.join(".register/fonts"))
        .expect("fonts dir")
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert!(stored.is_empty(), "it stored something anyway: {stored:?}");
}

#[test]
fn settings_persist_where_04_says_they_do() {
    let root = scratch("config");
    let vault = root.join("vault");
    register(&["init", vault.to_str().expect("utf-8")], &root);

    let server = Server::start(&vault);
    let mut stream = server.connect();
    let body = r#"{"scheme":"dark","bodyFace":"teletype"}"#;
    let head = format!(
        "PUT /api/config HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        server.addr,
        body.len()
    );
    stream.write_all(head.as_bytes()).expect("write");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).expect("read");
    assert!(raw.starts_with("HTTP/1.1 204"), "{raw}");

    let stored = std::fs::read_to_string(vault.join(".register/config.json")).expect("read");
    assert!(stored.contains("teletype"), "{stored}");
    // Config is a vault file and belongs in a commit; only fonts and trash do not.
    assert!(!stored.contains("licensed"));
}
