use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

/// A throwaway vault that deletes itself. Hand-rolled rather than pulling in
/// `tempfile`, which is not on §04's dependency list and would need an ADR.
pub struct TempVault {
    root: PathBuf,
}

impl TempVault {
    pub fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let nth = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("register-test-{nanos:x}-{nth:x}"));
        fs::create_dir_all(&root).expect("create temp vault");
        // Canonicalised to match what `Vault::open` stores. On macOS the temp
        // dir is a symlink (/var -> /private/var), so an uncanonicalised path
        // would fail every `strip_prefix` against the vault root.
        let root = root.canonicalize().expect("canonicalize temp vault");
        Self { root }
    }

    pub fn path(&self) -> &std::path::Path {
        &self.root
    }

    pub fn open(&self) -> Vault {
        Vault::open(&self.root).expect("open temp vault")
    }

    pub fn put(&self, rel: &str, body: &str) {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, body).expect("seed file");
    }
}

impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

const NOTE: &str = "---\nid: 01J2ZK7Q8W3E5R9T\nref: 003\ntitle: Terminal aesthetics\ncreated: 2026-07-28\nmodified: 2026-08-04T13:47:00Z\ntags: [design, research]\n---\nBody text.\n";

// ---------------------------------------------------------------- path safety

#[test]
fn rejects_paths_that_escape_the_vault() {
    let tmp = TempVault::new();
    let vault = tmp.open();

    for hostile in [
        "../secrets.md",
        "notes/../../secrets.md",
        "/etc/passwd",
        "notes/../.register/config.json",
        "..",
        "",
        "/",
        "notes\\..\\secrets.md",
    ] {
        assert!(
            matches!(
                vault.read(hostile),
                Err(Error::InvalidPath | Error::NotFound)
            ),
            "{hostile} should not resolve"
        );
        assert!(
            matches!(vault.write(hostile, "x", None), Err(Error::InvalidPath)),
            "{hostile} should not be writable"
        );
    }
}

#[test]
fn refuses_to_touch_the_app_directory() {
    let tmp = TempVault::new();
    tmp.put(".register/config.json", "{}");
    let vault = tmp.open();

    assert!(matches!(
        vault.read(".register/config.json"),
        Err(Error::InvalidPath)
    ));
    assert!(matches!(
        vault.write(".register/config.json", "{}", None),
        Err(Error::InvalidPath)
    ));
    assert!(matches!(
        vault.trash(".register/config.json"),
        Err(Error::InvalidPath)
    ));
}

// ------------------------------------------------------------------- read/write

#[test]
fn writes_then_reads_back_byte_for_byte() {
    let tmp = TempVault::new();
    let vault = tmp.open();

    let etag = vault.write("notes/003-a.md", NOTE, None).expect("write");
    let (body, read_etag) = vault.read("notes/003-a.md").expect("read");

    assert_eq!(body, NOTE);
    assert_eq!(etag, read_etag);
}

#[test]
fn creates_missing_parent_directories() {
    let tmp = TempVault::new();
    let vault = tmp.open();

    vault
        .write("deep/nested/dir/note.md", "hello", None)
        .expect("write");
    assert!(tmp.path().join("deep/nested/dir/note.md").is_file());
}

#[test]
fn leaves_no_temp_files_behind() {
    let tmp = TempVault::new();
    let vault = tmp.open();

    vault.write("notes/003-a.md", NOTE, None).expect("write");

    let strays: Vec<_> = fs::read_dir(tmp.path().join("notes"))
        .expect("read dir")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with('.'))
        .collect();
    assert_eq!(strays, Vec::<String>::new());
}

// ----------------------------------------------------------------- etag guard

#[test]
fn stale_etag_is_a_conflict_and_reports_the_current_one() {
    let tmp = TempVault::new();
    let vault = tmp.open();

    let first = vault.write("notes/003-a.md", NOTE, None).expect("write");
    // A different length guarantees a different etag even if the filesystem's
    // mtime granularity is too coarse to distinguish two writes.
    let second = vault
        .write("notes/003-a.md", "changed underneath you", Some(&first))
        .expect("write with correct etag");
    assert_ne!(first, second);

    match vault.write("notes/003-a.md", "my edit", Some(&first)) {
        Err(Error::Conflict { current }) => assert_eq!(current, second),
        other => panic!("expected conflict, got {other:?}"),
    }
}

#[test]
fn matching_etag_is_accepted() {
    let tmp = TempVault::new();
    let vault = tmp.open();

    let etag = vault.write("notes/003-a.md", NOTE, None).expect("write");
    assert!(vault.write("notes/003-a.md", "next", Some(&etag)).is_ok());
}

#[test]
fn etag_on_a_vanished_note_is_a_conflict_not_a_create() {
    let tmp = TempVault::new();
    let vault = tmp.open();

    assert!(matches!(
        vault.write("notes/404.md", "body", Some("stale-etag")),
        Err(Error::Conflict { .. })
    ));
    assert!(!tmp.path().join("notes/404.md").exists());
}

#[test]
fn no_etag_creates_the_note() {
    let tmp = TempVault::new();
    let vault = tmp.open();

    assert!(vault.write("notes/new.md", "body", None).is_ok());
}

// --------------------------------------------------------------------- trash

#[test]
fn delete_moves_to_trash_and_never_removes() {
    let tmp = TempVault::new();
    let vault = tmp.open();
    vault.write("notes/003-a.md", NOTE, None).expect("write");

    vault.trash("notes/003-a.md").expect("trash");

    assert!(!tmp.path().join("notes/003-a.md").exists());
    assert_eq!(trashed_bodies(tmp.path()), [NOTE]);
}

/// Every trashed note body, whatever bucket it landed in.
fn trashed_bodies(root: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.join(APP_DIR).join("trash")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(body) = fs::read_to_string(&path) {
                out.push(body);
            }
        }
    }
    out.sort();
    out
}

#[test]
fn trash_keeps_a_note_at_its_original_path() {
    let tmp = TempVault::new();
    let vault = tmp.open();
    vault.write("notes/003-a.md", NOTE, None).expect("write");
    vault.trash("notes/003-a.md").expect("trash");

    // The original path is what lets next_ref recover the ref this note used.
    let mut found = Vec::new();
    let mut stack = vec![tmp.path().join(APP_DIR).join("trash")];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).expect("read").flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                found.push(path);
            }
        }
    }
    assert_eq!(found.len(), 1);
    assert!(
        found[0].to_string_lossy().ends_with("notes/003-a.md"),
        "{found:?}"
    );
}

// ------------------------------------------------------------------ next ref

#[test]
fn next_ref_is_one_above_the_highest_note() {
    let tmp = TempVault::new();
    tmp.put("notes/001-a.md", NOTE);
    tmp.put("notes/004-b.md", NOTE);
    let vault = tmp.open();

    // Highest, not first free: the gap at 002 stays a gap.
    assert_eq!(vault.next_ref().expect("next ref"), "005");
}

#[test]
fn next_ref_starts_at_000_for_an_empty_vault() {
    let tmp = TempVault::new();
    assert_eq!(tmp.open().next_ref().expect("next ref"), "000");
}

#[test]
fn next_ref_never_reissues_a_deleted_ref() {
    let tmp = TempVault::new();
    let vault = tmp.open();
    vault.write("notes/000-a.md", NOTE, None).expect("write");
    vault.write("notes/003-b.md", NOTE, None).expect("write");

    vault.trash("notes/003-b.md").expect("trash");

    // Under §04's original "highest EXISTING + 1" this returned 001, handing
    // a live ref to a second note and silently re-pointing any [[001]] link.
    assert_eq!(vault.next_ref().expect("next ref"), "004");
}

#[test]
fn next_ref_ignores_daily_logs() {
    let tmp = TempVault::new();
    tmp.put("daily/2026-08-04.md", NOTE);
    tmp.put("notes/002-a.md", NOTE);
    let vault = tmp.open();

    // A daily filename is a date; treating 2026 as a ref would jump the counter.
    assert_eq!(vault.next_ref().expect("next ref"), "003");
}

#[test]
fn tree_reports_the_vault_and_the_next_ref() {
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    let vault = tmp.open();

    let tree = vault.tree().expect("tree");
    assert_eq!(tree.vault, tmp.path().display().to_string());
    assert_eq!(tree.next_ref, "004");
    assert_eq!(tree.notes.len(), 1);
}

#[test]
fn trashing_twice_keeps_both_revisions() {
    let tmp = TempVault::new();
    let vault = tmp.open();

    for body in ["first", "second"] {
        vault.write("notes/003-a.md", body, None).expect("write");
        vault.trash("notes/003-a.md").expect("trash");
    }

    let count = fs::read_dir(tmp.path().join(APP_DIR).join("trash"))
        .expect("read trash")
        .count();
    assert_eq!(count, 2);
}

#[test]
fn trashing_a_missing_note_is_not_found() {
    let tmp = TempVault::new();
    let vault = tmp.open();
    assert!(matches!(vault.trash("notes/404.md"), Err(Error::NotFound)));
}

// ------------------------------------------------------------ symlink escape

#[cfg(unix)]
#[test]
fn a_symlinked_directory_cannot_escape_the_vault() {
    let outside = TempVault::new();
    fs::write(outside.path().join("secret.md"), "SSH KEY MATERIAL").expect("seed");

    let tmp = TempVault::new();
    // Exactly what `ln -s ~/somewhere <vault>/archive` produces, and an
    // entirely ordinary thing to find in a user's notes folder.
    std::os::unix::fs::symlink(outside.path(), tmp.path().join("escape")).expect("symlink");
    let vault = tmp.open();

    assert!(matches!(
        vault.read("escape/secret.md"),
        Err(Error::InvalidPath)
    ));
    assert!(matches!(
        vault.write("escape/pwned.md", "owned", None),
        Err(Error::InvalidPath)
    ));
    assert!(matches!(
        vault.trash("escape/secret.md"),
        Err(Error::InvalidPath)
    ));

    assert_eq!(
        fs::read_to_string(outside.path().join("secret.md")).expect("still there"),
        "SSH KEY MATERIAL"
    );
    assert!(!outside.path().join("pwned.md").exists());
}

#[cfg(unix)]
#[test]
fn a_symlinked_note_cannot_expose_a_file_outside() {
    let outside = TempVault::new();
    let secret = outside.path().join("hosts");
    fs::write(&secret, "127.0.0.1 localhost").expect("seed");

    let tmp = TempVault::new();
    fs::create_dir_all(tmp.path().join("notes")).expect("mkdir");
    std::os::unix::fs::symlink(&secret, tmp.path().join("notes/006-link.md")).expect("symlink");
    let vault = tmp.open();

    assert!(matches!(
        vault.read("notes/006-link.md"),
        Err(Error::InvalidPath)
    ));
}

#[cfg(unix)]
#[test]
fn a_symlink_cannot_smuggle_writes_into_the_app_directory() {
    let tmp = TempVault::new();
    fs::create_dir_all(tmp.path().join(APP_DIR)).expect("mkdir");
    std::os::unix::fs::symlink(tmp.path().join(APP_DIR), tmp.path().join("appdir"))
        .expect("symlink");
    let vault = tmp.open();

    assert!(matches!(
        vault.write("appdir/config.json", "{}", None),
        Err(Error::InvalidPath)
    ));
    assert!(!tmp.path().join(APP_DIR).join("config.json").exists());
}

// ------------------------------------------------------------ concurrency

#[test]
fn concurrent_writes_with_the_same_etag_produce_exactly_one_winner() {
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;

    let tmp = TempVault::new();
    let vault = Arc::new(tmp.open());
    let shared = vault.write("notes/003-a.md", "seed", None).expect("seed");

    let won = Arc::new(AtomicUsize::new(0));
    let lost = Arc::new(AtomicUsize::new(0));

    let threads: Vec<_> = (0..16)
        .map(|n| {
            let (vault, shared) = (vault.clone(), shared.clone());
            let (won, lost) = (won.clone(), lost.clone());
            std::thread::spawn(move || {
                let body = format!("writer {n:02} body");
                match vault.write("notes/003-a.md", &body, Some(&shared)) {
                    Ok(_) => won.fetch_add(1, Ordering::Relaxed),
                    Err(Error::Conflict { .. }) => lost.fetch_add(1, Ordering::Relaxed),
                    Err(other) => panic!("unexpected {other:?}"),
                };
            })
        })
        .collect();
    for thread in threads {
        thread.join().expect("thread");
    }

    assert_eq!(
        won.load(Ordering::Relaxed),
        1,
        "an etag is a claim on one version; only one writer may hold it"
    );
    assert_eq!(lost.load(Ordering::Relaxed), 15);
}

#[test]
fn concurrent_deletions_never_destroy_a_note() {
    use std::sync::Arc;

    let tmp = TempVault::new();
    let vault = Arc::new(tmp.open());

    // Same basename, different folders: every one lands on the same
    // `<millis>-007-note.md` candidate in the trash.
    let folders = ["a", "b", "c", "d", "e", "f", "g", "h"];
    for folder in folders {
        vault
            .write(
                &format!("{folder}/007-note.md"),
                &format!("unique content of {folder}"),
                None,
            )
            .expect("seed");
    }

    let threads: Vec<_> = folders
        .iter()
        .map(|folder| {
            let vault = vault.clone();
            let rel = format!("{folder}/007-note.md");
            std::thread::spawn(move || vault.trash(&rel))
        })
        .collect();
    for thread in threads {
        thread.join().expect("thread").expect("trash");
    }

    let kept = trashed_bodies(tmp.path());

    let mut expected: Vec<String> = folders
        .iter()
        .map(|folder| format!("unique content of {folder}"))
        .collect();
    expected.sort();

    assert_eq!(
        kept, expected,
        "§04 promises deletion never destroys; every note must be recoverable"
    );
}

// ---------------------------------------------------------------------- tree

#[test]
fn lists_notes_and_derives_their_metadata() {
    let tmp = TempVault::new();
    tmp.put("notes/003-terminal-aesthetics.md", NOTE);
    let vault = tmp.open();

    let tree = vault.list().expect("list");
    assert_eq!(tree.len(), 1);

    let entry = &tree[0];
    assert_eq!(entry.path, "notes/003-terminal-aesthetics.md");
    assert_eq!(entry.reference.as_deref(), Some("003"));
    assert_eq!(entry.title.as_deref(), Some("Terminal aesthetics"));
    assert_eq!(entry.tags, ["design", "research"]);
    assert_eq!(entry.size as usize, NOTE.len());
    assert!(entry.mtime > 0);
    assert!(!entry.etag.is_empty());
}

#[test]
fn tree_hides_dotfiles_the_app_directory_and_non_notes() {
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    tmp.put(".register/config.json", "{}");
    tmp.put(".register/trash/old.md", NOTE);
    tmp.put(".hidden.md", NOTE);
    tmp.put("notes/.swp.md", NOTE);
    tmp.put("notes/image.png", "not markdown");
    let vault = tmp.open();

    let paths: Vec<_> = vault
        .list()
        .expect("list")
        .into_iter()
        .map(|e| e.path)
        .collect();
    assert_eq!(paths, ["notes/003-a.md"]);
}

#[test]
fn tree_survives_a_note_with_no_frontmatter() {
    let tmp = TempVault::new();
    tmp.put("notes/007-bare.md", "Just a body, no frontmatter.\n");
    let vault = tmp.open();

    let tree = vault.list().expect("list");
    assert_eq!(tree.len(), 1);
    assert_eq!(tree[0].reference.as_deref(), Some("007"));
    assert_eq!(tree[0].title, None);
    assert!(tree[0].tags.is_empty());
}

#[test]
fn tree_survives_malformed_frontmatter() {
    let tmp = TempVault::new();
    tmp.put(
        "notes/008-broken.md",
        "---\ntitle: [unterminated\n  ::: nonsense\n---\nBody.\n",
    );
    let vault = tmp.open();

    let tree = vault.list().expect("list");
    assert_eq!(tree.len(), 1, "one bad note must not sink the tree");
    assert_eq!(tree[0].reference.as_deref(), Some("008"));
}

#[test]
fn only_markdown_is_a_note() {
    let tmp = TempVault::new();
    tmp.put("notes/image.png", "not markdown");
    let vault = tmp.open();

    // resolve, list and is_visible must share one definition, or PUT creates
    // files the tree can never show and the watcher never reports.
    assert!(matches!(
        vault.write("notes/image.png", "x", None),
        Err(Error::InvalidPath)
    ));
    assert!(matches!(
        vault.read("notes/image.png"),
        Err(Error::InvalidPath)
    ));
    assert!(vault.list().expect("list").is_empty());
    assert!(!vault.is_visible(&tmp.path().join("notes/image.png")));
}

#[test]
fn a_daily_log_has_no_ref() {
    let tmp = TempVault::new();
    // §04 has two filename shapes; only `NNN-slug.md` carries a ref. Without
    // the separator check the date would report a ref of "2026".
    tmp.put("daily/2026-08-04.md", "---\ntitle: Tuesday\n---\nlog\n");
    tmp.put("notes/000-inbox.md", "---\ntitle: Inbox\n---\ncapture\n");
    let vault = tmp.open();

    let tree = vault.list().expect("list");
    let daily = tree
        .iter()
        .find(|e| e.path.starts_with("daily/"))
        .expect("daily");
    let note = tree
        .iter()
        .find(|e| e.path.starts_with("notes/"))
        .expect("note");

    assert_eq!(daily.reference, None);
    assert_eq!(note.reference.as_deref(), Some("000"));
}

#[test]
fn a_byte_order_mark_does_not_hide_the_frontmatter() {
    let tmp = TempVault::new();
    let with_bom = format!("\u{feff}{NOTE}");
    tmp.put("notes/009-bom.md", &with_bom);
    let vault = tmp.open();

    let tree = vault.list().expect("list");
    assert_eq!(tree[0].title.as_deref(), Some("Terminal aesthetics"));

    // §04's losslessness invariant: the BOM survives the round trip untouched.
    let (body, _) = vault.read("notes/009-bom.md").expect("read");
    assert_eq!(body, with_bom);
}

#[test]
fn tree_is_sorted_by_path() {
    let tmp = TempVault::new();
    for name in ["notes/003-c.md", "notes/001-a.md", "notes/002-b.md"] {
        tmp.put(name, NOTE);
    }
    let vault = tmp.open();

    let paths: Vec<_> = vault
        .list()
        .expect("list")
        .into_iter()
        .map(|e| e.path)
        .collect();
    assert_eq!(
        paths,
        ["notes/001-a.md", "notes/002-b.md", "notes/003-c.md"]
    );
}

#[test]
fn visibility_agrees_with_the_tree() {
    let tmp = TempVault::new();
    let vault = tmp.open();
    let root = tmp.path();

    assert!(vault.is_visible(&root.join("notes/003-a.md")));
    assert!(!vault.is_visible(&root.join(".register/trash/003-a.md")));
    assert!(!vault.is_visible(&root.join("notes/.register-tmp-1")));
    assert!(!vault.is_visible(&root.join("notes/image.png")));
    assert!(!vault.is_visible(std::path::Path::new("/elsewhere/003-a.md")));
}
