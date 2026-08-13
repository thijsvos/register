use std::fs;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast;

use notify::event::{AccessKind, AccessMode, DataChange, ModifyKind};

use super::*;
use crate::vault::tests::TempVault;

/// Give the platform watcher time to arm before touching anything.
///
/// This used to say that FSEvents "only reports events raised after the stream
/// starts". It does not, and believing it is what made these tests flaky: the
/// fixture creates its temp directory and seeds a note *before* `Watch::start`,
/// and macOS delivers those events to the stream anyway. Measured on a release
/// build, where the whole sequence is fast enough to land in one window:
///
///   Create(Folder) …/register-test-…      the fixture making the vault
///   Create(File)   …/notes/003-a.md       the fixture seeding the note
///   Modify(Data)   …/notes/003-a.md
///   Create(File)   …/notes/.register-tmp- the write actually under test
///   Modify(Name)   …/notes/003-a.md       its rename
///
/// So `drain` collected the seed's event alongside the write's and the
/// assertion read as a debouncer leak. It never was one.
const ARM: Duration = Duration::from_millis(300);

/// Long enough to catch a second batch if the debouncer were leaking one.
const SETTLE: Duration = Duration::from_millis(600);

/// Wait for the watcher to arm, then throw away what the fixture itself caused.
///
/// Waiting alone is not enough — the events are queued in the broadcast, not
/// discarded by the passage of time — so this empties the channel and then
/// checks again, because the first pass can fall between two batches.
async fn arm(rx: &mut broadcast::Receiver<Event>) {
    for _ in 0..2 {
        tokio::time::sleep(ARM).await;
        while rx.try_recv().is_ok() {}
    }
}

/// Everything broadcast within `SETTLE`, in arrival order.
async fn drain(rx: &mut broadcast::Receiver<Event>) -> Vec<Event> {
    let deadline = Instant::now() + SETTLE;
    let mut seen = Vec::new();
    while let Ok(Ok(event)) = timeout_at(deadline, rx.recv()).await {
        seen.push(event);
    }
    seen
}

#[tokio::test]
async fn an_external_write_emits_exactly_one_event() {
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", "seed\n");
    let vault = Arc::new(tmp.open());
    let (tx, mut rx) = broadcast::channel(64);
    let _watch = Watch::start(vault, tx).expect("start watcher");
    arm(&mut rx).await;

    fs::write(tmp.path().join("notes/003-a.md"), "edited by an agent\n").expect("write");

    let seen = drain(&mut rx).await;
    assert_eq!(seen.len(), 1, "expected one coalesced event, got {seen:?}");
    assert_eq!(seen[0].change, Change::Changed);
    assert_eq!(seen[0].path, "notes/003-a.md");
    assert!(seen[0].etag.is_some());
}

#[tokio::test]
async fn a_burst_of_writes_coalesces_to_one_event() {
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", "seed\n");
    let vault = Arc::new(tmp.open());
    let (tx, mut rx) = broadcast::channel(64);
    let _watch = Watch::start(vault, tx).expect("start watcher");
    arm(&mut rx).await;

    for n in 0..8 {
        fs::write(tmp.path().join("notes/003-a.md"), format!("revision {n}\n")).expect("write");
    }

    let seen = drain(&mut rx).await;
    assert_eq!(seen.len(), 1, "eight writes should coalesce, got {seen:?}");
    assert_eq!(seen[0].change, Change::Changed);
}

#[tokio::test]
async fn a_new_note_reports_created_and_a_deletion_reports_removed() {
    let tmp = TempVault::new();
    let vault = Arc::new(tmp.open());
    let (tx, mut rx) = broadcast::channel(64);
    let _watch = Watch::start(vault, tx).expect("start watcher");
    arm(&mut rx).await;

    fs::create_dir_all(tmp.path().join("notes")).expect("mkdir");
    fs::write(tmp.path().join("notes/004-new.md"), "fresh\n").expect("create");

    let seen = drain(&mut rx).await;
    assert_eq!(seen.len(), 1, "expected one create, got {seen:?}");
    assert_eq!(seen[0].change, Change::Created);
    assert_eq!(seen[0].path, "notes/004-new.md");

    fs::remove_file(tmp.path().join("notes/004-new.md")).expect("remove");

    let seen = drain(&mut rx).await;
    assert_eq!(seen.len(), 1, "expected one remove, got {seen:?}");
    assert_eq!(seen[0].change, Change::Removed);
    assert_eq!(seen[0].path, "notes/004-new.md");
    assert_eq!(seen[0].etag, None);
}

#[tokio::test]
async fn renaming_a_folder_of_notes_is_reported() {
    let tmp = TempVault::new();
    tmp.put("notes/sub/010-a.md", "one\n");
    tmp.put("notes/sub/011-b.md", "two\n");
    let vault = Arc::new(tmp.open());
    let (tx, mut rx) = broadcast::channel(64);
    let _watch = Watch::start(vault, tx).expect("start watcher");
    arm(&mut rx).await;

    // A directory event carries no `.md`, so per-path stats cannot see it at
    // all: without the resync path this rename is completely invisible and the
    // watcher's idea of the vault stays wrong forever.
    fs::rename(tmp.path().join("notes/sub"), tmp.path().join("notes/moved")).expect("rename");

    let mut seen = drain(&mut rx).await;
    seen.sort_by(|a, b| a.path.cmp(&b.path));

    let created: Vec<_> = seen
        .iter()
        .filter(|e| e.change == Change::Created)
        .map(|e| e.path.as_str())
        .collect();
    let removed: Vec<_> = seen
        .iter()
        .filter(|e| e.change == Change::Removed)
        .map(|e| e.path.as_str())
        .collect();

    assert_eq!(created, ["notes/moved/010-a.md", "notes/moved/011-b.md"]);
    assert_eq!(removed, ["notes/sub/010-a.md", "notes/sub/011-b.md"]);
}

#[tokio::test]
async fn the_app_directory_and_dotfiles_are_silent() {
    let tmp = TempVault::new();
    let vault = Arc::new(tmp.open());
    let (tx, mut rx) = broadcast::channel(64);
    let _watch = Watch::start(vault, tx).expect("start watcher");
    arm(&mut rx).await;

    tmp.put(".register/config.json", "{\"theme\":\"dark\"}");
    tmp.put(".register/trash/003-old.md", "trashed\n");
    tmp.put("notes/.4913.md", "vim swap probe\n");
    tmp.put("notes/image.png", "not a note");

    let seen = drain(&mut rx).await;
    assert!(seen.is_empty(), "nothing should be reported, got {seen:?}");
}

#[tokio::test]
async fn the_servers_own_atomic_write_reports_one_change_not_a_temp_file() {
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", "seed\n");
    let vault = Arc::new(tmp.open());
    let (tx, mut rx) = broadcast::channel(64);
    let _watch = Watch::start(vault.clone(), tx).expect("start watcher");
    arm(&mut rx).await;

    // Exercises the real tmp+rename path, which is what vim and VS Code also do.
    vault
        .write("notes/003-a.md", "written through vault.rs\n", None)
        .expect("write");

    let seen = drain(&mut rx).await;
    assert_eq!(seen.len(), 1, "expected one event, got {seen:?}");
    assert_eq!(seen[0].change, Change::Changed);
    assert_eq!(seen[0].path, "notes/003-a.md");
}

#[tokio::test]
async fn reading_a_note_is_not_a_change() {
    // The regression that cost CI its e2e job. `notify` subscribes to
    // `WatchMask::OPEN` on Linux, so every note the server opens in order to
    // serve it produced an event; filling the corpus of a 1k-note vault made a
    // thousand of them, overflowed the broadcast, and the client's reconnect
    // re-read the vault that had caused it. macOS cannot reproduce it —
    // FSEvents does not report opens — so this drives `absorb` directly.
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", "---\nref: 003\n---\nBody.\n");
    let vault = tmp.open();
    let path = tmp.path().join("notes/003-a.md");

    let mut pending = HashSet::new();

    for ignored in [
        AccessKind::Open(AccessMode::Any),
        AccessKind::Read,
        AccessKind::Close(AccessMode::Read),
    ] {
        let event = notify::Event::new(EventKind::Access(ignored)).add_path(path.clone());
        assert!(
            !absorb(&vault, Ok(event), &mut pending),
            "{ignored:?} asked for a resync"
        );
        assert!(pending.is_empty(), "{ignored:?} was treated as a change");
    }

    // A finished write still announces itself, on the same Access branch.
    let closed = notify::Event::new(EventKind::Access(AccessKind::Close(AccessMode::Write)))
        .add_path(path.clone());
    absorb(&vault, Ok(closed), &mut pending);
    assert_eq!(pending.len(), 1, "a completed write went unnoticed");

    pending.clear();
    let modified =
        notify::Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any))).add_path(path);
    absorb(&vault, Ok(modified), &mut pending);
    assert_eq!(pending.len(), 1, "an ordinary write went unnoticed");
}
