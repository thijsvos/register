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

    // The empty tag especially, which is the one this used to let through: the
    // comparison flattened "no file" to `""`, so `If-Match: ""` matched a
    // deleted note and created it. Not a hypothetical value either — a conflict
    // on an already-vanished path reported `current: ""`, the server put that on
    // the wire as `ETag: ""`, and a client retrying with the tag the 409 gave it
    // sent exactly this.
    assert!(
        matches!(
            vault.write("notes/404.md", "body", Some("")),
            Err(Error::Conflict { .. })
        ),
        "an empty If-Match created a note that was not there"
    );
    assert!(!tmp.path().join("notes/404.md").exists());
}

#[test]
fn a_path_below_a_regular_file_is_not_there_rather_than_a_server_fault() {
    // `notes/003-a.md/x.md` raises ENOTDIR, not ENOENT, and every one of these
    // used to answer `Error::Io` — a 500 blaming the server for a request it
    // understood perfectly well, plus a line on stderr calling it a vault fault.
    // Reachable from the UI, not only from curl: `cleanFolder` accepts
    // `CLAUDE.md` as a folder, so typing `CLAUDE.md/My note` into the palette
    // went straight here.
    let tmp = TempVault::new();
    let vault = tmp.open();
    vault.write("notes/003-a.md", NOTE, None).expect("write");

    let under_a_file = "notes/003-a.md/child.md";
    assert!(
        matches!(vault.read(under_a_file), Err(Error::NotFound)),
        "reading below a file was reported as an I/O fault"
    );
    assert!(
        matches!(
            vault.write(under_a_file, "body", None),
            Err(Error::NotFound | Error::InvalidPath)
        ),
        "writing below a file was reported as an I/O fault"
    );
}

#[test]
fn a_ref_another_note_holds_is_refused() {
    // §04 Rev F: a ref is allocated once and never reissued. The server hands
    // out `nextRef`, so one client cannot reissue one — but two tabs fetching
    // the tree in the same instant both receive `015`, pick different slugs, and
    // land on different paths, so the free-name check passes for both. A
    // `[[015]]` link then resolves to whichever the index reaches first.
    let tmp = TempVault::new();
    let vault = tmp.open();

    vault
        .write("notes/015-launch.md", NOTE, None)
        .expect("the first tab writes");

    match vault.write("notes/015-review.md", NOTE, None) {
        Err(Error::RefTaken { taken }) => assert_eq!(taken, "notes/015-launch.md"),
        other => panic!("expected RefTaken, got {other:?}"),
    }
    assert!(
        !tmp.path().join("notes/015-review.md").exists(),
        "the second note was written anyway"
    );

    // The next ref is free, which is what the client retries with.
    assert!(vault.write("notes/016-review.md", NOTE, None).is_ok());
}

#[test]
fn a_note_rewriting_itself_still_holds_its_own_ref() {
    // The check must not fire on an ordinary save, which is every save.
    let tmp = TempVault::new();
    let vault = tmp.open();

    let etag = vault
        .write("notes/015-launch.md", NOTE, None)
        .expect("write");
    assert!(
        vault
            .write("notes/015-launch.md", "second revision\n", Some(&etag))
            .is_ok(),
        "a note could not save over itself"
    );
    // And without an etag either — `create` is not the only caller.
    assert!(vault.write("notes/015-launch.md", "third\n", None).is_ok());
}

#[test]
fn a_path_with_no_ref_cannot_collide() {
    // A daily log is named for its date and takes no ref (§04), and a conflict
    // copy deliberately has none. Neither can collide, so neither is checked.
    let tmp = TempVault::new();
    let vault = tmp.open();

    assert!(vault.write("daily/2026-08-17.md", NOTE, None).is_ok());
    assert!(vault.write("daily/2026-08-18.md", NOTE, None).is_ok());

    vault.write("notes/015-a.md", NOTE, None).expect("write");
    assert!(
        vault
            .write("notes/015-a.conflict-20260817T100000000Z.md", NOTE, None)
            .is_ok(),
        "a conflict copy of a note was refused for taking its ref"
    );
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

// -------------------------------------------------------------- trash folder

/// Seed a folder holding two notes, a PNG and a nested note.
fn seeded_folder(tmp: &TempVault) {
    tmp.put("notes/projects/010-a.md", NOTE);
    tmp.put("notes/projects/011-b.md", NOTE);
    // Contents are irrelevant: a folder deletion moves the directory whole and
    // never looks inside a file, which is exactly why it can take media at all.
    tmp.put("notes/projects/diagram.png", "pretend png");
    tmp.put("notes/projects/deep/012-c.md", NOTE);
}

#[test]
fn trashing_a_folder_moves_the_whole_subtree_into_one_bucket() {
    let tmp = TempVault::new();
    let vault = tmp.open();
    seeded_folder(&tmp);

    let moved = vault.trash_folder("notes/projects").expect("trash folder");

    assert!(!tmp.path().join("notes/projects").exists());
    // One bucket. This is the property the whole endpoint exists for — a
    // client-side loop over DELETE /api/note produces one per note, and the
    // folder can then only be restored by hand.
    let buckets = fs::read_dir(tmp.path().join(APP_DIR).join("trash"))
        .expect("read trash")
        .count();
    assert_eq!(buckets, 1);

    // At its original vault path inside that bucket, exactly as a single note
    // is — which is what keeps the refs it used recoverable.
    let bucket = tmp.path().join(&moved.bucket);
    assert!(bucket.join("notes/projects/010-a.md").is_file());
    assert!(bucket.join("notes/projects/deep/012-c.md").is_file());
}

#[test]
fn trashing_a_folder_takes_the_media_with_it() {
    // The reason this is not a loop over DELETE /api/note: `trash` goes through
    // `resolve`, which is .md-only, so a client doing it note by note leaves
    // every image behind in a folder the INDEX now draws as gone.
    let tmp = TempVault::new();
    let vault = tmp.open();
    seeded_folder(&tmp);

    let moved = vault.trash_folder("notes/projects").expect("trash folder");

    assert!(
        tmp.path()
            .join(&moved.bucket)
            .join("notes/projects/diagram.png")
            .is_file()
    );
    assert_eq!((moved.notes, moved.files), (3, 1));
}

#[test]
fn a_trashed_folder_still_holds_its_refs_against_reuse() {
    // next_ref reads the trash precisely so a deleted ref is never handed out
    // again, and it can only do that while the notes sit at their original
    // paths. A folder deletion must not be the hole in that.
    let tmp = TempVault::new();
    let vault = tmp.open();
    seeded_folder(&tmp);
    assert_eq!(vault.next_ref().expect("next"), "013");

    vault.trash_folder("notes/projects").expect("trash folder");

    assert_eq!(vault.next_ref().expect("next"), "013");
}

#[test]
fn trashing_a_folder_prunes_what_it_left_empty() {
    let tmp = TempVault::new();
    let vault = tmp.open();
    tmp.put("notes/areas/work/alpha/001-a.md", NOTE);

    vault
        .trash_folder("notes/areas/work/alpha")
        .expect("trash folder");

    // `work/` and `areas/` held nothing else, so the INDEX draws neither — and
    // a folder the app says is gone must not still be sitting in Finder.
    assert!(!tmp.path().join("notes/areas/work").exists());
    assert!(!tmp.path().join("notes/areas").exists());
    // `notes/` is the §04 layout, not a folder the reader made. It stays even
    // when it is empty, or the vault loses its own shape on the last deletion.
    assert!(tmp.path().join("notes").is_dir());
}

#[test]
fn pruning_stops_at_a_parent_that_still_holds_something() {
    let tmp = TempVault::new();
    let vault = tmp.open();
    tmp.put("notes/areas/work/alpha/001-a.md", NOTE);
    tmp.put("notes/areas/work/002-b.md", NOTE);

    vault
        .trash_folder("notes/areas/work/alpha")
        .expect("trash folder");

    assert!(tmp.path().join("notes/areas/work/002-b.md").is_file());
}

#[test]
fn trashing_the_last_note_in_a_folder_prunes_it_too() {
    // The single-note path has the same obligation: the folder row disappears
    // when its last note does, so the directory must not outlive it.
    let tmp = TempVault::new();
    let vault = tmp.open();
    tmp.put("notes/areas/solo/001-a.md", NOTE);

    vault.trash("notes/areas/solo/001-a.md").expect("trash");

    assert!(!tmp.path().join("notes/areas/solo").exists());
    assert!(tmp.path().join("notes").is_dir());
}

#[test]
fn a_folder_holding_something_unswept_is_left_alone() {
    // `remove_dir` refuses a non-empty directory, and that refusal is the whole
    // guard: nothing here may remove a file, so somebody's leftovers survive.
    let tmp = TempVault::new();
    let vault = tmp.open();
    tmp.put("notes/areas/solo/001-a.md", NOTE);
    tmp.put("notes/areas/solo/.DS_Store", "junk");

    vault.trash("notes/areas/solo/001-a.md").expect("trash");

    assert!(tmp.path().join("notes/areas/solo/.DS_Store").is_file());
}

#[test]
fn the_vault_root_is_not_a_folder_anyone_can_delete() {
    let tmp = TempVault::new();
    let vault = tmp.open();
    tmp.put("notes/003-a.md", NOTE);

    for named in ["", ".", "/", "./"] {
        assert!(
            matches!(vault.trash_folder(named), Err(Error::InvalidPath)),
            "{named:?} reached the root"
        );
    }
    assert!(tmp.path().join("notes/003-a.md").is_file());
}

#[test]
fn a_folder_delete_takes_every_guard_the_note_api_takes() {
    // The point of `resolve_within`: dropping only the .md rule, never a guard.
    // Each of these names something that exists, so a NotFound would prove
    // nothing about whether the guard is there.
    let tmp = TempVault::new();
    let vault = tmp.open();
    tmp.put("notes/003-a.md", NOTE);
    tmp.put(".register/config.json", "{}");
    fs::create_dir_all(tmp.path().join(".register/fonts")).expect("fonts dir");

    for named in [
        "../..",
        "notes/../../etc",
        ".register",
        ".register/fonts",
        "/etc",
        "notes\\projects",
    ] {
        assert!(
            matches!(vault.trash_folder(named), Err(Error::InvalidPath)),
            "{named:?} was not refused"
        );
    }
    assert!(tmp.path().join(".register/config.json").is_file());
}

#[test]
fn a_note_is_not_a_folder() {
    let tmp = TempVault::new();
    let vault = tmp.open();
    tmp.put("notes/003-a.md", NOTE);

    assert!(matches!(
        vault.trash_folder("notes/003-a.md"),
        Err(Error::NoSuchFolder)
    ));
    assert!(tmp.path().join("notes/003-a.md").is_file());
}

#[test]
fn trashing_a_missing_folder_says_so() {
    let tmp = TempVault::new();
    let vault = tmp.open();
    assert!(matches!(
        vault.trash_folder("notes/nowhere"),
        Err(Error::NoSuchFolder)
    ));
}

#[test]
fn a_bucket_name_already_taken_is_not_reused() {
    // One deletion is one bucket — the property the whole endpoint rests on, and
    // the reason the destination is *claimed* with `create_dir` rather than
    // probed. `create_dir_all` would succeed on a name that already exists, so
    // two deletions in one millisecond would share a bucket and stop being
    // separately restorable.
    //
    // Deterministic rather than timing-dependent: the first version of this
    // test deleted two folders back to back and asserted the buckets differed,
    // which they did — because the two calls landed in different milliseconds.
    // It passed with the claim removed, which is a test that proves nothing.
    // Every name the next 50 ms could produce is taken up front instead.
    let tmp = TempVault::new();
    let vault = tmp.open();
    tmp.put("notes/one/001-a.md", NOTE);

    let trash = tmp.path().join(APP_DIR).join("trash");
    fs::create_dir_all(&trash).expect("trash dir");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    for stamp in (now - 2)..(now + 50) {
        fs::create_dir(trash.join(stamp.to_string())).expect("claim a name");
    }

    let moved = vault.trash_folder("notes/one").expect("trash folder");

    // It had to step past every taken name, so the suffix is the evidence.
    assert!(
        moved.bucket.ends_with("-1"),
        "reused a taken bucket: {}",
        moved.bucket
    );
    assert!(
        tmp.path()
            .join(&moved.bucket)
            .join("notes/one/001-a.md")
            .is_file()
    );
    // And nothing was poured into the name that was already there.
    assert_eq!(
        fs::read_dir(trash.join(now.to_string()))
            .expect("read the taken bucket")
            .count(),
        0
    );
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
    // The folder route drops the `.md` rule and nothing else. This is the one
    // it would be easiest to lose, because a directory *is* what it takes and a
    // symlinked one looks exactly like the real thing to everything but
    // `symlink_metadata` — and losing it turns a deletion into `rm -r` on
    // whatever the link points at.
    assert!(matches!(
        vault.trash_folder("escape"),
        Err(Error::InvalidPath)
    ));

    assert_eq!(
        fs::read_to_string(outside.path().join("secret.md")).expect("still there"),
        "SSH KEY MATERIAL"
    );
    assert!(!outside.path().join("pwned.md").exists());
    assert!(
        outside.path().is_dir(),
        "the linked-to directory was removed"
    );
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
    //
    // Seeded on disk rather than through `write`, which now refuses a second
    // note taking a ref another note holds. That refusal guards *creation*
    // through the API; a vault can still contain duplicate refs, because an
    // agent editing the files directly is not something the server gets a vote
    // on — and refusing to trash what a vault actually holds would be the wrong
    // lesson to take from it. This is that vault.
    let folders = ["a", "b", "c", "d", "e", "f", "g", "h"];
    for folder in folders {
        tmp.put(
            &format!("{folder}/007-note.md"),
            &format!("unique content of {folder}"),
        );
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

#[test]
fn a_conflict_copy_takes_no_ref_and_does_not_consume_one() {
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", NOTE);
    // Exactly what the client writes on a 409.
    tmp.put("notes/003-a.conflict-20260805T091640123Z.md", NOTE);
    let vault = tmp.open();

    let tree = vault.list().expect("list");
    let copy = tree
        .iter()
        .find(|entry| entry.path.contains(".conflict-"))
        .expect("the copy is still listed");

    // Visible in the index — you have to find it to merge it — but it must not
    // answer to [[003]] alongside the note it was copied from.
    assert_eq!(copy.reference, None);
    assert_eq!(vault.next_ref().expect("next ref"), "004");
}

/// `.register/` is unreachable through the API, which for a long time was taken
/// to mean its paths needed no containment check. That holds only while the
/// vault is one you made: git preserves symlinks, so a vault cloned from
/// somewhere else can point `config.json` or the stored face at any file the
/// server can read — and both are served over HTTP.
// Gated whole, not by an inner block. With `#[cfg(unix)]` on the block the
// test still *ran* on Windows — with an empty body, reporting green for a
// guard it had not exercised. A test that cannot run should say so by being
// absent, which is what the three above already do.
#[cfg(unix)]
#[test]
fn a_symlinked_app_file_is_refused_rather_than_followed() {
    let tmp = TempVault::new();
    let vault = tmp.open();

    let outside = tmp.path().parent().expect("parent").join("outside-secret");
    fs::write(&outside, "SECRET\n").expect("write secret");

    let app = tmp.path().join(".register");
    fs::create_dir_all(app.join("fonts")).expect("mkdir");
    let _ = fs::remove_file(app.join("config.json"));

    {
        use std::os::unix::fs::symlink;
        symlink(&outside, app.join("config.json")).expect("link config");
        symlink(&outside, app.join("fonts/licensed.woff2")).expect("link font");

        let config = vault.read_config();
        assert!(
            config.is_err(),
            "a linked config was read: {:?}",
            config.ok()
        );
        assert!(
            vault.font().is_none(),
            "a linked font was offered for serving"
        );
        // …and a write through the link must not reach the target either.
        let _ = vault.write_config("{}");
        assert_eq!(
            fs::read_to_string(&outside).expect("read secret"),
            "SECRET\n",
            "writing config followed the link and clobbered a file outside the vault"
        );
    }
}

/// The vault root can be renamed or deleted while the server runs.
///
/// `require_root` exists so a write after that fails instead of succeeding:
/// without it `create_dir_all` cheerfully resurrects the old tree and the server
/// answers 200 while writing into a ghost directory nobody is watching, and the
/// user's actual vault — the one they moved — never sees the note.
///
/// Found by `cargo-mutants`: replacing the whole function with `Ok(())` survived
/// the entire suite. Deleting a guard should never be invisible.
#[test]
fn a_write_after_the_vault_moves_fails_rather_than_resurrecting_it() {
    let tmp = TempVault::new();
    let vault = tmp.open();
    vault
        .write("notes/003-a.md", NOTE, None)
        .expect("first write");

    // The user renames the folder out from under the running server.
    let moved = tmp.path().with_extension("moved");
    fs::rename(tmp.path(), &moved).expect("rename the vault");

    let after = vault.write("notes/004-b.md", NOTE, None);
    assert!(
        after.is_err(),
        "a write succeeded into a vault that is no longer there"
    );
    assert!(
        !tmp.path().exists(),
        "the old root was recreated — the note went somewhere nobody is watching"
    );

    // Put it back so TempVault's Drop can clean up.
    fs::rename(&moved, tmp.path()).expect("restore");
}

/// A write must not follow a symlink out of the vault.
///
/// Honest about which guard earns this: `verify_contained` does, by walking every
/// component before anything is created. `verify_parent` is the *second* look,
/// after `create_dir_all`, and it only matters when the link appears between the
/// two calls — a race a test cannot open on demand. `cargo-mutants` shows that
/// by surviving `verify_parent -> Ok(())` while this test still passes, and
/// ADR-006 records it as a reasoned survivor rather than an oversight.
#[cfg(unix)]
#[test]
fn a_symlink_cannot_smuggle_a_parent_directory_out_of_the_vault() {
    use std::os::unix::fs::symlink;

    let tmp = TempVault::new();
    let outside = tmp.path().parent().expect("parent").join("smuggled");
    fs::create_dir_all(&outside).expect("mkdir outside");
    let vault = tmp.open();

    // `notes/away` is a link out. A write beneath it must not land outside.
    fs::create_dir_all(tmp.path().join("notes")).expect("mkdir notes");
    symlink(&outside, tmp.path().join("notes/away")).expect("symlink");

    let escaped = vault.write("notes/away/005-e.md", NOTE, None);
    assert!(
        escaped.is_err(),
        "a write followed a symlink out of the vault"
    );
    assert!(
        !outside.join("005-e.md").exists(),
        "the note landed outside the vault: {}",
        outside.display()
    );
}

/// `GET /api/file` reuses every guard `read` has except the `.md` rule.
///
/// The whole risk of the endpoint is that it declines *one* check; these pin
/// that it declined only that one. Written against the same hostile paths the
/// note API is tested with, because a guard that protects one caller and not the
/// other is the failure this split was designed to avoid.
mod media {
    use super::*;

    /// The smallest valid PNG: an 8-byte signature is all `media_format` reads.
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";
    const PDF: &[u8] = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";

    fn put_bytes(tmp: &TempVault, rel: &str, bytes: &[u8]) {
        let path = tmp.path().join(rel);
        fs::create_dir_all(path.parent().expect("parent")).expect("create dir");
        fs::write(path, bytes).expect("write bytes");
    }

    #[test]
    fn serves_an_image_that_the_note_api_will_not() {
        let tmp = TempVault::new();
        put_bytes(&tmp, "notes/diagram.png", PNG);
        let vault = tmp.open();

        // The note API still refuses it — that rule did not move.
        assert!(matches!(
            vault.read("notes/diagram.png"),
            Err(Error::InvalidPath)
        ));
        assert!(!vault.is_visible(&tmp.path().join("notes/diagram.png")));

        let (bytes, format, etag) = vault.read_media("notes/diagram.png").expect("media");
        assert_eq!(bytes, PNG);
        assert_eq!(format.media_type, "image/png");
        assert!(!etag.is_empty());
    }

    #[test]
    fn refuses_every_path_the_note_api_refuses() {
        let tmp = TempVault::new();
        let vault = tmp.open();

        for hostile in [
            "../secrets.png",
            "notes/../../secrets.png",
            "/etc/passwd",
            "notes/../.register/config.json",
            "..",
            "",
            "/",
            "notes\\..\\secrets.png",
        ] {
            assert!(
                matches!(
                    vault.read_media(hostile),
                    Err(Error::InvalidPath | Error::NotFound)
                ),
                "{hostile} should not resolve through /api/file"
            );
        }
    }

    #[test]
    fn the_app_directory_stays_unreachable_even_holding_a_real_image() {
        // Asserted against a file that EXISTS, and against `InvalidPath`
        // specifically. The first version of this test listed `.register/…`
        // among the traversal paths and accepted `NotFound` — which a temp
        // vault answers for anything under `.register/` whether the guard holds
        // or not. Deleting the dot-segment guard passed the whole suite.
        let tmp = TempVault::new();
        put_bytes(&tmp, ".register/fonts/decoy.png", PNG);
        put_bytes(&tmp, ".register/config.json", b"{}");
        let vault = tmp.open();

        for hidden in [".register/fonts/decoy.png", ".register/config.json"] {
            assert!(
                matches!(vault.read_media(hidden), Err(Error::InvalidPath)),
                "{hidden} must be refused as a path, not merely missing"
            );
        }
        // The control: the same bytes under an ordinary name are served, so the
        // refusal above is the dot-segment rule and not the allowlist.
        put_bytes(&tmp, "notes/decoy.png", PNG);
        assert!(vault.read_media("notes/decoy.png").is_ok());
    }

    #[test]
    fn a_symlink_cannot_serve_a_file_from_outside_the_vault() {
        let tmp = TempVault::new();
        let outside = tmp.path().parent().expect("parent").join("outside.png");
        fs::write(&outside, PNG).expect("write outside");

        let link = tmp.path().join("notes/escape.png");
        fs::create_dir_all(link.parent().expect("parent")).expect("create dir");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).expect("symlink");

        let vault = tmp.open();
        assert!(
            matches!(
                vault.read_media("notes/escape.png"),
                Err(Error::InvalidPath)
            ),
            "a symlink out of the vault must be refused, not followed"
        );
        // The positive control: those bytes really are readable, so the refusal
        // above is the guard rather than a missing file.
        assert_eq!(fs::read(&outside).expect("read outside"), PNG);
    }

    #[test]
    fn the_type_comes_from_the_bytes_and_never_from_the_name() {
        let tmp = TempVault::new();
        // A note renamed to look like an image, which is the case an
        // extension-based server would happily hand over as image/png.
        put_bytes(
            &tmp,
            "notes/trick.png",
            b"---\nref: 003\n---\n# not an image\n",
        );
        put_bytes(
            &tmp,
            "notes/page.png",
            b"<!doctype html><script>alert(1)</script>",
        );
        // And the mirror: a real PDF wearing the wrong extension is still served
        // as a PDF, because nothing here reads the extension at all.
        put_bytes(&tmp, "notes/report.txt", PDF);
        let vault = tmp.open();

        assert!(matches!(
            vault.read_media("notes/trick.png"),
            Err(Error::UnsupportedMedia)
        ));
        assert!(matches!(
            vault.read_media("notes/page.png"),
            Err(Error::UnsupportedMedia)
        ));
        let (_, format, _) = vault.read_media("notes/report.txt").expect("media");
        assert_eq!(format.media_type, "application/pdf");
    }

    #[test]
    fn every_listed_format_is_recognised_by_its_own_magic() {
        // A table test rather than one case, because the offset-based entries
        // (WebP, AVIF) use a different matcher from the prefix ones and a
        // single PNG case would exercise only half of it.
        let webp = b"RIFF\x00\x00\x00\x00WEBPVP8 ";
        let avif = b"\x00\x00\x00\x20ftypavif\x00\x00\x00\x00";
        for (bytes, wanted) in [
            (PNG, "image/png"),
            (&[0xFF, 0xD8, 0xFF, 0xE0][..], "image/jpeg"),
            (b"GIF87a\x00\x00", "image/gif"),
            (b"GIF89a\x00\x00", "image/gif"),
            (&webp[..], "image/webp"),
            (&avif[..], "image/avif"),
            (PDF, "application/pdf"),
        ] {
            let found = media_format(bytes).unwrap_or_else(|| panic!("{wanted} not recognised"));
            assert_eq!(found.media_type, wanted);
        }

        assert!(media_format(b"").is_none());
        assert!(
            media_format(b"RIFF\x00\x00\x00\x00WAVE").is_none(),
            "a wav is not an image"
        );
    }

    #[test]
    fn svg_is_recognised_by_its_root_element() {
        // It has no magic number, being XML, so it is the one format sniffed by
        // finding its root element rather than by matching bytes at an offset.
        for accepted in [
            &b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"[..],
            b"<svg>\n<rect/>\n</svg>\n",
            b"  \n\t<svg viewBox=\"0 0 1 1\"></svg>",
            b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg/>",
            b"<?xml version=\"1.0\"?>\n<!-- drawn by hand -->\n<svg/>",
            b"<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"x.dtd\">\n<svg/>",
            // A BOM, which a Windows editor will happily add.
            "\u{feff}<svg/>".as_bytes(),
        ] {
            let found = media_format(accepted)
                .unwrap_or_else(|| panic!("not recognised: {}", String::from_utf8_lossy(accepted)));
            assert_eq!(found.media_type, "image/svg+xml");
        }

        // The *root* element, not "contains `<svg`". An HTML page can hold one,
        // and serving HTML from this origin is what the allowlist exists to
        // prevent — so a page that merely embeds a drawing is refused, and being
        // served as `image/svg+xml` would not have made it safe.
        for refused in [
            &b"<html><body><svg/></body></html>"[..],
            b"<!DOCTYPE html>\n<html><svg/></html>",
            b"<svgnotreally/>",
            b"# a markdown note mentioning <svg/>\n",
            b"<?xml version=\"1.0\"?><rss><svg/></rss>",
            // An unterminated prologue is not a document.
            b"<?xml version=\"1.0\"\n<svg/>",
            b"<!-- forever",
        ] {
            assert!(
                media_format(refused).is_none(),
                "should be refused: {}",
                String::from_utf8_lossy(refused)
            );
        }
    }

    #[test]
    fn a_file_larger_than_the_cap_is_refused_before_it_is_read() {
        let tmp = TempVault::new();
        let mut big = PNG.to_vec();
        big.resize((MAX_MEDIA_BYTES + 1) as usize, 0);
        put_bytes(&tmp, "notes/huge.png", &big);
        let vault = tmp.open();

        assert!(matches!(
            vault.read_media("notes/huge.png"),
            Err(Error::TooLarge)
        ));
    }

    #[test]
    fn the_etag_can_be_had_without_reading_the_file() {
        let tmp = TempVault::new();
        put_bytes(&tmp, "notes/diagram.png", PNG);
        let vault = tmp.open();

        let (_, _, from_read) = vault.read_media("notes/diagram.png").expect("media");
        let from_stat = vault.media_etag("notes/diagram.png").expect("etag");
        assert_eq!(
            from_read, from_stat,
            "a conditional request must compare the same value the body carries"
        );
        assert!(matches!(
            vault.media_etag("notes/missing.png"),
            Err(Error::NotFound)
        ));
    }
}

/// The shared path table, read by this side and by `app/src/core/paths.test.ts`.
///
/// `cleanFolder` mirrors `resolve_within` segment by segment, and a mirror is a
/// thing that can drift. The duplication is deliberate — the client has to judge
/// a path before `fetch` rewrites the URL and before a case-folding filesystem
/// rewrites it, neither of which the server can see — so what was missing was
/// not a de-duplication but a table both copies are held to.
///
/// The table gives each side its own column, because on two rows they disagree
/// and one verdict would have had to hide it: `Path::components` normalises an
/// empty component away, so this side reads `notes//x.md` as `notes/x.md` while
/// the client refuses the empty segment outright. Same file either way, so it is
/// a difference in strictness rather than a hole — but it is written down now.
#[test]
fn the_shared_path_table_agrees_with_this_side() {
    let raw = fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/paths.json"),
    )
    .expect("read tests/fixtures/paths.json");
    let table: serde_json::Value = serde_json::from_str(&raw).expect("parse paths.json");
    let cases = table["cases"].as_array().expect("cases");

    // Anti-vacuity: an emptied or renamed table must fail rather than pass by
    // having nothing left to disagree with.
    assert!(
        cases.len() >= 15,
        "the table lost its cases: {}",
        cases.len()
    );

    let tmp = TempVault::new();
    let vault = tmp.open();

    for case in cases {
        let path = case["path"].as_str().expect("path");
        let expected = case["server"].as_bool().expect("server");
        let why = case["why"].as_str().unwrap_or("");

        // A folder is only ever reached through a file inside it, which is what
        // `resolve_within` judges — and what `cleanFolder` is asked too.
        let asked = format!("{path}/x.md");
        assert_eq!(
            vault.resolve_within(&asked).is_ok(),
            expected,
            "{path:?} — {why}"
        );
    }
}

#[test]
fn a_vault_is_claimed_by_one_process_at_a_time() {
    // `vault.rs` serialises writes with an in-process `Mutex`, which is exactly
    // enough for one server and nothing at all for two: both would read an etag,
    // compare it, and rename over each other, and `create`'s "is this name free"
    // check has the same shape — so two servers could hand out one ref.
    let tmp = TempVault::new();
    let vault = tmp.open();

    let claim = vault.claim().expect("first claim");

    // A second `Vault` over the same directory is what a second `register serve`
    // has, and it must be refused rather than allowed to race.
    let second = tmp.open();
    match second.claim() {
        Err(Error::AlreadyServed { lock, held }) => {
            // The message has to be actionable: which file, and who says they
            // hold it. This process is the holder and is plainly alive, so this
            // is also the liveness gate proving it does not take over its own
            // claim — the failure mode a takeover rule invites.
            assert!(lock.ends_with(".lock"), "lock path: {lock}");
            assert!(
                held.contains("pid"),
                "the claim does not name a pid: {held}"
            );
            // And which vault: the filename is a hash, so a human reading it
            // should never have to guess what it is holding.
            assert!(
                held.contains(&tmp.path().display().to_string()),
                "the claim does not name its vault: {held}"
            );
        }
        Err(other) => panic!("expected AlreadyServed, got {other}"),
        Ok(_) => panic!("two processes both claimed one vault"),
    }

    // Releasing is what makes a restart work, and it is tied to the guard's
    // lifetime rather than to anyone remembering to call something.
    drop(claim);
    let third = tmp.open().claim().expect("claim after release");
    drop(third);
}

#[test]
fn a_claim_left_by_a_killed_process_does_not_lock_the_vault_out() {
    // A process killed outright never reaches `Drop`, so its claim outlives it.
    // Obeying that file would mean one `docker kill` makes a vault unstartable
    // until a human deletes something — a worse failure than the race the claim
    // exists to prevent, and a new one this feature would have introduced.
    let tmp = TempVault::new();
    let vault = tmp.open();

    // A pid that is certainly not running: one this test started and reaped, so
    // the kernel has genuinely retired it rather than this guessing a number.
    let mut dead = std::process::Command::new("true")
        .spawn()
        .expect("spawn a process to kill");
    let gone = dead.id();
    dead.wait().expect("reap it");

    let path = vault.claim_path_for_test();
    fs::write(&path, format!("pid {gone} · {}\n", tmp.path().display())).expect("write a claim");

    let taken = vault.claim().expect("a dead holder does not hold");
    // Taken over rather than shared: the file is this process's claim now, and a
    // third server still gets refused.
    let held = fs::read_to_string(taken.path()).expect("read the claim");
    assert!(
        held.contains(&format!("pid {}", std::process::id())),
        "the claim still names the dead process: {held}"
    );
    assert!(
        tmp.open().claim().is_err(),
        "taking over a stale claim left the vault unclaimed"
    );

    drop(taken);
    assert!(!path.exists(), "the taken-over claim outlived the guard");
}

#[test]
fn a_claim_naming_a_vault_that_is_gone_is_stale_without_asking_about_its_pid() {
    // The claim is keyed on the directory's inode, and a filesystem reissues an
    // inode once the directory holding it is deleted — so every throwaway vault
    // that ever existed can leave a file a later, unrelated vault has to
    // disprove. Measured: a few hundred of those left by the e2e suite were
    // enough to push `start → editable` past §06's 500 ms, because each one cost
    // a `fork`+`exec` of `kill`. A running server holds a directory it opened,
    // so a claim naming one that is not there cannot be one anybody is serving.
    let tmp = TempVault::new();
    let vault = tmp.open();
    let path = vault.claim_path_for_test();

    // A live pid — this process — so the liveness probe would say "held". The
    // vault it names is what makes it stale, and nothing else can.
    fs::write(
        &path,
        format!(
            "pid {} · {}\n",
            std::process::id(),
            tmp.path().join("a-vault-that-was-deleted").display()
        ),
    )
    .expect("write a claim");

    let taken = vault
        .claim()
        .expect("a claim for a vault that is gone is not held");
    drop(taken);
}

#[test]
fn a_claim_naming_this_very_process_is_still_stale_if_this_process_is_not_holding_it() {
    // The container shape, and the one that would have shipped broken. Under an
    // exec-form entrypoint the server is pid 1, so a claim stranded by a
    // `docker kill` reads `pid 1` — and the replacement container's server is
    // also pid 1. `kill -0` on yourself always succeeds, so the liveness probe
    // would answer "still running" every time and the vault would never start
    // again: exactly the lock-out the takeover exists to prevent, reached
    // through the one pid the probe cannot speak about.
    let tmp = TempVault::new();
    let vault = tmp.open();
    let path = vault.claim_path_for_test();

    let mine = std::process::id();
    fs::write(&path, format!("pid {mine} · {}\n", tmp.path().display())).expect("write a claim");

    let taken = vault
        .claim()
        .expect("a claim this process is not holding is not held");

    // And the inverse, which is what stops that rule swallowing the real case:
    // now that this process *is* holding it, a second `Vault` over the same
    // directory — a second server, as far as everything else here is concerned —
    // is refused, even though the claim names the pid asking.
    assert!(
        tmp.open().claim().is_err(),
        "a claim this process holds was taken over by this process"
    );
    drop(taken);
}

#[test]
fn a_claim_is_released_even_when_the_server_never_asked() {
    // The guard's `Drop`, which is what a graceful shutdown relies on: `serve`
    // holds the claim for the life of the process, so SIGTERM unwinding is what
    // removes the file.
    let tmp = TempVault::new();

    {
        let claim = tmp.open().claim().expect("claim");
        assert!(claim.path().is_file(), "no claim file was written");
        // And nowhere near the vault: one untracked file in `.register/` makes a
        // vault under git dirty for as long as the app runs.
        assert!(
            !claim.path().starts_with(tmp.path()),
            "the claim is inside the vault: {}",
            claim.path().display()
        );
    }
    assert!(
        !tmp.open().claim_path_for_test().exists(),
        "the claim outlived the guard"
    );
}
