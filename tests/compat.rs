//! §09 layer 4: "a vault written by v1 opens unchanged in every later minor —
//! §04 is the contract."
//!
//! Reader-only, and that is the entire point. Every other test in this
//! repository builds its vault from a string literal declared in the same
//! commit — usually the same file, in the same language — as the code that reads
//! it, so a change that moves the writer and the reader together stays green.
//! Nothing here calls `register init` or `register new`. The input is
//! `tests/fixtures/vault-v1/`, which is frozen, and the only question asked is
//! whether today's binary can still read it.
//!
//! Half the fixture is things this app would never write. That is deliberate: a
//! vault is edited by agents, by vim, by whatever the user has to hand, and §04
//! is a promise about what can be read, not only about what gets written.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BINARY: &str = env!("CARGO_BIN_EXE_register");
const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/vault-v1");
/// Long enough for a loaded box, short enough that a hang fails rather than sits.
const PATIENCE: Duration = Duration::from_secs(5);

// ------------------------------------------------------------------ scaffolding

/// A throwaway copy of the frozen fixture.
///
/// Never served in place: `serve` writes `.register/config.json`, the watcher
/// touches the tree, and a test that mutated the fixture would quietly rewrite
/// the one input in this repository that is supposed to outlive the code.
/// Read a response, accepting a reset once one has arrived.
///
/// A server that answers without draining the request body closes with unread
/// bytes still in the socket, and the kernel sends RST — which a real client
/// tolerates and `read_to_string` does not. It surfaced on the CI runner as
/// several tests failing at once with `Connection reset by peer` where the same
/// suite is green on a developer machine, which is the shape of a race the
/// slower box loses more often rather than a fault it has.
///
/// The assertion is what keeps this honest: a reset with *nothing* read is still
/// a failure, and says so.
fn read_tolerating_reset(stream: &mut TcpStream, into: &mut String) {
    if let Err(error) = stream.read_to_string(into) {
        assert!(
            !into.is_empty(),
            "no response before the connection dropped: {error}"
        );
    }
}

fn copy_of_fixture() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // The clock alone is not unique enough. `cargo test` runs these in parallel
    // threads and `SystemTime::now()` is coarser than a nanosecond on macOS, so
    // two tests read the same value, land on one directory, and the first to
    // finish deletes it underneath the second. A counter makes the name unique
    // within the process, which is the only place the collision can happen.
    static NTH: AtomicU64 = AtomicU64::new(0);
    let nth = NTH.fetch_add(1, Ordering::Relaxed);

    let path = std::env::temp_dir().join(format!("register-compat-{nanos:x}-{nth:x}"));
    std::fs::create_dir_all(&path).expect("create scratch");

    // `cp -R src/. dest` copies the contents including dotfiles on both macOS
    // and Linux, and preserves bytes — which `include_str!` would too, but only
    // for files valid UTF-8 at compile time, and only one at a time.
    let status = Command::new("cp")
        .args(["-R", &format!("{FIXTURE}/."), path.to_str().expect("utf-8")])
        .status()
        .expect("run cp");
    assert!(status.success(), "could not copy the fixture");
    path
}

fn read(vault: &Path, rel: &str) -> Vec<u8> {
    std::fs::read(vault.join(rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

struct Server {
    child: Child,
    addr: String,
    vault: PathBuf,
}

impl Server {
    fn on_the_fixture() -> Self {
        let vault = copy_of_fixture();
        let mut child = Command::new(BINARY)
            .args(["serve", vault.to_str().expect("utf-8 path"), "--port", "0"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn server");

        let stdout = child.stdout.take().expect("piped stdout");
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .expect("read banner");
        let addr = line
            .rsplit_once("http://")
            .map(|(_, rest)| rest.trim().to_owned())
            .unwrap_or_else(|| panic!("no address in banner: {line:?}"));

        Self { child, addr, vault }
    }

    fn get(&self, path: &str) -> String {
        let mut stream = TcpStream::connect(&self.addr).expect("connect");
        stream
            .set_read_timeout(Some(PATIENCE))
            .expect("set timeout");
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
            self.addr
        );
        stream.write_all(request.as_bytes()).expect("write request");
        let mut raw = String::new();
        read_tolerating_reset(&mut stream, &mut raw);
        raw.split_once("\r\n\r\n")
            .map(|(_, body)| body.to_owned())
            .unwrap_or_default()
    }

    fn tree(&self) -> String {
        self.get("/api/tree")
    }

    /// Unconditional PUT — no `If-Match`, because §04 makes that a plain write
    /// and what is under test here is the bytes, not the etag guard.
    fn put(&self, path: &str, body: &str) {
        let mut stream = TcpStream::connect(&self.addr).expect("connect");
        stream
            .set_read_timeout(Some(PATIENCE))
            .expect("set timeout");
        let request = format!(
            "PUT {path} HTTP/1.1\r\nHost: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            self.addr,
            body.len()
        );
        stream.write_all(request.as_bytes()).expect("write headers");
        stream.write_all(body.as_bytes()).expect("write body");

        let mut raw = String::new();
        read_tolerating_reset(&mut stream, &mut raw);
        let status = raw.lines().next().unwrap_or_default();
        assert!(
            status.starts_with("HTTP/1.1 2"),
            "PUT {path} refused: {status}"
        );
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.vault);
    }
}

// ------------------------------------------------------------------ the fixture

#[test]
fn the_fixture_survives_being_copied() {
    // The non-vacuity control for every test below. All of them read a copy, so
    // if `cp` normalised a line ending or dropped a BOM they would be asserting
    // against something this repository does not actually contain.
    let vault = copy_of_fixture();

    for rel in [
        "notes/003-terminal-aesthetics.md",
        "notes/004-loose-fence.md",
        "notes/005-crlf.md",
        "notes/006-bom.md",
        "notes/010-no-newline.md",
    ] {
        assert_eq!(
            read(&vault, rel),
            std::fs::read(Path::new(FIXTURE).join(rel)).expect("read fixture"),
            "{rel} changed on the way into the scratch copy"
        );
    }

    // And the oddities are still odd, so a fixture someone "tidied" fails here
    // rather than passing everything else for the wrong reason.
    assert!(
        read(&vault, "notes/004-loose-fence.md").starts_with(b"--- \n"),
        "the loose fence lost its trailing space"
    );
    assert!(
        read(&vault, "notes/005-crlf.md").starts_with(b"---\r\n"),
        "the CRLF note was normalised to LF"
    );
    assert!(
        read(&vault, "notes/006-bom.md").starts_with(b"\xef\xbb\xbf"),
        "the byte order mark is gone"
    );
    assert!(
        !read(&vault, "notes/010-no-newline.md").ends_with(b"\n"),
        "a trailing newline was added"
    );

    let _ = std::fs::remove_dir_all(&vault);
}

// ------------------------------------------------------------------ §04 reading

#[test]
fn an_ordinary_note_reads_as_v1_wrote_it() {
    // The control. If this fails, nothing else in this file is worth reading —
    // the fixture is broken rather than the reader.
    let server = Server::on_the_fixture();
    let tree = server.tree();

    assert!(
        tree.contains(r#""title":"Terminal aesthetics""#),
        "the plainest note in the fixture lost its title: {tree}"
    );
    assert!(tree.contains(r#""ref":"003""#), "003 lost its ref: {tree}");
    assert!(
        tree.contains(r#""design""#) && tree.contains(r#""doctrine""#),
        "003 lost its tags: {tree}"
    );
}

#[test]
fn an_opening_fence_with_a_trailing_space_is_still_frontmatter() {
    // `--- ` — three dashes and one space — is what an editor or an agent emits
    // without thinking, and the client already accepts it:
    // `app/src/core/frontmatter.ts` matches /^---[ \t]*\r?\n/.
    //
    // The server does not, so the note renders perfectly in the editor while
    // /api/tree reports it with no title and no tags. `frontmatter.ts` names the
    // consequence for a different route to the same place: "a note loses its
    // identity". Nothing recovers it, because tags and titles have no
    // client-side fallback — tags.ts reads them straight off this envelope.
    let server = Server::on_the_fixture();
    let tree = server.tree();

    assert!(
        tree.contains(r#""title":"Loose fence""#),
        "a fence with a trailing space cost the note its title: {tree}"
    );
    assert!(
        tree.contains(r#""edge""#),
        "a fence with a trailing space cost the note its tags: {tree}"
    );
}

#[test]
fn a_closing_fence_with_trailing_spaces_still_closes() {
    // The other half of the fence rule, and it was unguarded until a mutation
    // said so: with only the opening fence in the fixture, narrowing the closing
    // one to reject trailing blanks broke nothing here. It would have swallowed
    // the whole note body into the YAML block, where serde-saphyr rejects it and
    // the note goes anonymous — the same outcome, by the other door.
    let server = Server::on_the_fixture();
    assert!(
        server.tree().contains(r#""title":"Loose closing fence""#),
        "a closing fence with trailing spaces did not close the block"
    );
}

#[test]
fn a_crlf_note_keeps_its_title_and_tags() {
    let server = Server::on_the_fixture();
    assert!(
        server.tree().contains(r#""title":"Written on Windows""#),
        "CRLF frontmatter was not read"
    );
}

#[test]
fn a_byte_order_mark_does_not_hide_the_frontmatter() {
    let server = Server::on_the_fixture();
    assert!(
        server.tree().contains(r#""title":"Byte order mark""#),
        "a BOM hid the frontmatter"
    );
}

#[test]
fn a_note_with_no_trailing_newline_reads_normally() {
    let server = Server::on_the_fixture();
    assert!(
        server.tree().contains(r#""title":"No trailing newline""#),
        "the last byte not being a newline cost the note its title"
    );
}

#[test]
fn unknown_frontmatter_keys_do_not_stop_the_known_ones_being_read() {
    // §04 names six fields; a vault edited by anything else will carry more.
    // Unknown keys are not an error, they are somebody else's business.
    let server = Server::on_the_fixture();
    let tree = server.tree();

    assert!(
        tree.contains(r#""title":"Unknown keys""#),
        "an unknown key stopped the title being read: {tree}"
    );
    // And they are still on disk, untouched — the server never rewrites YAML.
    let body = read(&server.vault, "notes/007-unknown-keys.md");
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("status: draft"), "an unknown key was dropped");
    assert!(
        text.contains("# a comment in the frontmatter"),
        "a YAML comment was dropped"
    );
}

#[test]
fn yaml_this_app_would_not_have_written_is_still_read() {
    // Widening the fixture after the fence bug found none of these broken, which
    // is worth pinning precisely because it is the good news: §04 names flow-style
    // tags and three-digit refs, and a vault edited by anything else will carry
    // the rest. Each of these was untested until now.
    let server = Server::on_the_fixture();
    let tree = server.tree();

    // Block style, not §04's `[a, b]`.
    assert!(
        tree.contains(r#""path":"notes/012-block-tags.md","ref":"012","title":"Block style tags","tags":["design","edge"]"#),
        "block-style tags were not read: {tree}"
    );
    // An unquoted number in a list of strings coerces rather than failing the
    // whole note — which is the difference between one odd tag and no metadata.
    assert!(
        tree.contains(r#""title":"Numeric tag","tags":["2026","edge"]"#),
        "a numeric tag anonymised the note: {tree}"
    );
    // Unquoted dates and quoted colons are both scalars, not structure.
    assert!(
        tree.contains(r#""title":"2026-08-05""#),
        "an unquoted date title was not read: {tree}"
    );
    assert!(
        tree.contains(r#""title":"Terminal: aesthetics""#),
        "a quoted title containing a colon was not read: {tree}"
    );
}

#[test]
fn the_filename_owns_the_ref_and_the_frontmatter_does_not() {
    // §04: "filename = ref-slug". `016-ref-disagrees.md` says `ref: 999` in its
    // frontmatter. If the frontmatter ever won, a note could rename itself out
    // of the allocator's sight and `nextRef` would start reissuing.
    let server = Server::on_the_fixture();
    let tree = server.tree();

    assert!(
        tree.contains(r#""path":"notes/016-ref-disagrees.md","ref":"016""#),
        "the frontmatter ref beat the filename: {tree}"
    );
    assert!(
        !tree.contains(r#""ref":"999""#),
        "a frontmatter ref reached the tree: {tree}"
    );
}

#[test]
fn a_note_with_no_frontmatter_is_still_a_note() {
    // §04 says what a note looks like; a file that is only prose is still one,
    // and its ref still comes from its name. Degrading to untitled is correct —
    // dropping it from the tree would hide a file the user can plainly see.
    let server = Server::on_the_fixture();
    assert!(
        server
            .tree()
            .contains(r#""path":"notes/017-bare.md","ref":"017","title":null,"tags":[]"#),
        "a note with no frontmatter was not read as an untitled note"
    );
}

#[test]
fn frontmatter_that_does_not_parse_degrades_without_taking_the_tree_down() {
    // `008-duplicate-key.md` has two `title:` keys, which serde-saphyr rejects
    // outright (ADR-001 chose it partly for that). `entry_for` then swallows the
    // error and defaults, so the note arrives untitled and untagged.
    //
    // That degradation is deliberate and right — §04's tree has to survive a
    // note an agent is halfway through writing, and one unparseable file must
    // not take down `GET /api/tree`. What was wrong is that it was never
    // written down or tested, while ADR-001 said the opposite would happen. It
    // is a contract now, so a future parser that starts throwing, or starts
    // last-write-wins, fails here rather than changing what a vault means in
    // silence.
    //
    // What is still missing is any way for the user to learn of it: the note is
    // indistinguishable from one nobody titled. That needs a §02b state for what
    // an unreadable note looks like in the index, and is recorded in
    // docs/ROADMAP.md rather than invented here.
    let server = Server::on_the_fixture();
    let tree = server.tree();

    assert!(
        tree.contains(r#""path":"notes/008-duplicate-key.md","ref":"008","title":null,"tags":[]"#),
        "a duplicate key no longer degrades the way this vault expects: {tree}"
    );
    // The whole point of degrading: everything around it still reads.
    assert!(
        tree.contains(r#""title":"Terminal aesthetics""#),
        "one unreadable note took its neighbours with it: {tree}"
    );
    assert!(
        server
            .get("/api/note/notes/008-duplicate-key.md")
            .contains("First title"),
        "the bytes are still served even though the metadata is not"
    );
}

#[test]
fn a_note_in_a_subfolder_is_found() {
    // §04 draws `notes/NNN-slug.md` flat. Nothing stops a user filing deeper,
    // and a walker that only looked one level down would lose the note silently.
    let server = Server::on_the_fixture();
    assert!(
        server
            .tree()
            .contains(r#""path":"notes/archive/018-nested.md""#),
        "a note one folder deeper was not found"
    );
}

#[test]
fn a_four_digit_ref_is_read_at_its_own_width() {
    let server = Server::on_the_fixture();
    let tree = server.tree();
    assert!(
        tree.contains(r#""ref":"0009""#),
        "a four-digit ref was not read as written: {tree}"
    );
}

#[test]
fn a_conflict_copy_carries_no_ref_of_its_own() {
    // §04: a copy is an artefact, not a note. It carries 003's ref and title
    // verbatim in its frontmatter, and if the tree honoured that, `[[003]]`
    // would have two candidates and every derivation would double.
    let server = Server::on_the_fixture();
    let tree = server.tree();

    assert!(
        tree.contains(".conflict-20260805T101500000Z.md"),
        "the conflict copy is not in the tree at all: {tree}"
    );
    // Exactly one entry may claim 003.
    assert_eq!(
        tree.matches(r#""ref":"003""#).count(),
        1,
        "a conflict copy claimed a ref: {tree}"
    );
}

#[test]
fn a_note_survives_a_round_trip_through_the_api_byte_for_byte() {
    // §04's central clause is "byte-lossless outside frontmatter `modified`".
    // The client side of that is `frontmatter.ts` and is tested over the same
    // fixture in `app/src/core/compat.test.ts`; this is the transport, where a
    // server that normalised a line ending, dropped a BOM, or added a trailing
    // newline on write would break every one of these notes silently.
    let server = Server::on_the_fixture();

    for rel in [
        "notes/005-crlf.md",
        "notes/006-bom.md",
        "notes/010-no-newline.md",
        "notes/007-unknown-keys.md",
    ] {
        let before = read(&server.vault, rel);
        let served = server.get(&format!("/api/note/{rel}"));
        assert_eq!(
            served.as_bytes(),
            before.as_slice(),
            "{rel} changed on the way out"
        );

        server.put(&format!("/api/note/{rel}"), &served);
        assert_eq!(
            read(&server.vault, rel),
            before,
            "{rel} changed on the way back in"
        );
    }
}

#[test]
fn a_ref_that_was_used_is_never_reissued() {
    // 002 exists only in `.register/trash/`, and 0009 is the highest ever
    // allocated. §04: "one above the highest NNN ever used, counting
    // .register/trash/ — never reuse a deleted ref."
    let server = Server::on_the_fixture();
    let tree = server.tree();

    for taken in ["\"000\"", "\"002\"", "\"003\"", "\"0009\""] {
        assert!(
            !tree.contains(&format!(r#""nextRef":{taken}"#)),
            "nextRef reissued {taken}: {tree}"
        );
    }
}
