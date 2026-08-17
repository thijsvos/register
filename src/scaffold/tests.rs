use std::collections::HashSet;
use std::fs;
use std::time::{Duration, UNIX_EPOCH};

use super::*;
use crate::vault::tests::TempVault;

/// `2026-08-05T09:16:40Z`, the instant the client's own tests use.
fn moment() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_785_921_400)
}

// ---------------------------------------------------------------- the contract

/// §04's template is normative, so it is compared against the spec itself
/// rather than against a copy of a copy. A silent drift here is the one failure
/// this phase cannot tolerate: the vault CLAUDE.md is the entire brief an agent
/// gets, and P8's acceptance is a fresh agent writing a valid note from it.
#[test]
fn the_vault_contract_matches_the_spec_verbatim() {
    let spec = fs::read_to_string("SPEC.html").expect("read SPEC.html");
    let opening = spec
        .find("Template · vault/CLAUDE.md")
        .expect("find the template block");
    let start = spec[opening..].find("<pre>").expect("find its <pre>") + opening + 5;
    let end = spec[start..].find("</pre>").expect("find its </pre>") + start;

    // The spec is HTML: `&amp;` and friends would arrive escaped. None appear in
    // this block today, and this asserts that stays true rather than assuming.
    let quoted = &spec[start..end];
    assert!(
        !quoted.contains('&'),
        "the template gained an HTML entity; unescape before comparing"
    );

    assert_eq!(
        quoted,
        VAULT_CLAUDE_MD.trim_end_matches('\n'),
        "src/scaffold.rs has drifted from SPEC.html §04"
    );
}

#[test]
fn the_contract_ends_with_exactly_one_newline() {
    assert!(VAULT_CLAUDE_MD.ends_with(".\n"));
    assert!(!VAULT_CLAUDE_MD.ends_with("\n\n"));
}

// --------------------------------------------------------------------- layout

#[test]
fn init_lays_out_exactly_the_tree_04_draws() {
    let tmp = TempVault::new();
    let root = tmp.path().join("fresh");
    let made = init(&root, false).expect("init");

    for dir in [
        "notes",
        "daily",
        "templates",
        ".register",
        ".register/fonts",
        ".register/trash",
    ] {
        assert!(root.join(dir).is_dir(), "missing directory {dir}");
    }

    let created: HashSet<&str> = made.created.iter().map(String::as_str).collect();
    assert_eq!(
        created,
        HashSet::from([
            "CLAUDE.md",
            "000-inbox.md",
            "templates/daily.md",
            ".register/config.json",
        ])
    );
    assert!(made.kept.is_empty());
}

#[test]
fn the_inbox_is_a_conforming_note_at_ref_000() {
    let tmp = TempVault::new();
    init(tmp.path(), false).expect("init");

    let inbox = fs::read_to_string(tmp.path().join("000-inbox.md")).expect("read inbox");
    assert!(inbox.starts_with("---\nid: "));
    assert!(inbox.contains("\nref: 000\n"));
    assert!(inbox.contains("\ntitle: Inbox\n"));
    assert!(inbox.contains("\ntags: [capture]\n"));

    // The vault must be able to read back what init wrote.
    let vault = tmp.open();
    let entry = vault
        .list()
        .expect("list")
        .into_iter()
        .find(|e| e.path == "000-inbox.md")
        .expect("inbox in the tree");
    assert_eq!(entry.title.as_deref(), Some("Inbox"));
    assert_eq!(entry.reference.as_deref(), Some("000"));
}

#[test]
fn a_fresh_vault_hands_out_001_next() {
    let tmp = TempVault::new();
    init(tmp.path(), false).expect("init");
    assert_eq!(tmp.open().next_ref().expect("next ref"), "001");
}

#[test]
fn the_daily_template_carries_no_task() {
    // An empty `- [ ]` in the stencil would land in every daily log and then in
    // every TODAY view, unfinished and unfinishable.
    assert!(!DAILY_TEMPLATE.contains("- ["));
    assert!(DAILY_TEMPLATE.contains("tags: [daily]"));
}

#[test]
fn init_never_overwrites_what_is_already_there() {
    let tmp = TempVault::new();
    init(tmp.path(), false).expect("first init");
    fs::write(tmp.path().join("CLAUDE.md"), "MY OWN CONTRACT\n").expect("edit contract");

    let again = init(tmp.path(), false).expect("second init");

    assert_eq!(
        fs::read_to_string(tmp.path().join("CLAUDE.md")).expect("read"),
        "MY OWN CONTRACT\n"
    );
    assert!(again.created.is_empty());
    assert!(again.kept.contains(&"CLAUDE.md".to_owned()));
}

#[test]
fn git_is_opt_in_and_ignores_the_two_directories_that_must_not_ship() {
    let tmp = TempVault::new();
    let plain = tmp.path().join("plain");
    init(&plain, false).expect("init");
    assert!(!plain.join(".gitignore").exists());

    let repo = tmp.path().join("repo");
    init(&repo, true).expect("init --git");
    let ignored = fs::read_to_string(repo.join(".gitignore")).expect("read .gitignore");
    assert!(ignored.contains(".register/fonts"));
    assert!(ignored.contains(".register/trash"));
    // `git init` is skipped rather than failed when git is unavailable on the
    // machine running the tests, so the repository itself is not asserted here.
}

/// Give the `git` children an identity through the environment.
///
/// `GIT_AUTHOR_*` / `GIT_COMMITTER_*` outrank config and are inherited by every
/// child, which is the only way to make a commit succeed on a machine that has
/// no `user.email` — a bare CI runner, for instance. Set once for the whole test
/// process; every test that cares wants the same values.
fn force_a_git_identity() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // Safety: called before any test spawns a git child, and the values are
        // constant, so no other thread can observe a half-written variable.
        unsafe {
            std::env::set_var("GIT_AUTHOR_NAME", "register tests");
            std::env::set_var("GIT_AUTHOR_EMAIL", "tests@register.invalid");
            std::env::set_var("GIT_COMMITTER_NAME", "register tests");
            std::env::set_var("GIT_COMMITTER_EMAIL", "tests@register.invalid");
        }
    });
}

#[test]
fn a_repository_we_did_not_create_is_never_committed_to() {
    // `git init` yourself, stage something, then point `register init --git` at
    // the folder. The baseline commit must not fire: `git add -A` would sweep
    // that staged work — and anything else in the directory — into a commit
    // called "vault: initial".
    let tmp = TempVault::new();
    let theirs = tmp.path().join("theirs");
    fs::create_dir_all(&theirs).expect("mkdir");

    // No silent early return when git is missing or `init` fails. Both used to
    // be bare `return`s, which meant this test reported green on a machine where
    // it had proved nothing — and its own final assertion reads only stdout,
    // which `git log` leaves empty when it exits 128 in a directory that is not
    // a repository. Between them, a change that blew away and recreated `.git`
    // would have passed while doing exactly the damage this test is named for.
    let made = std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(&theirs)
        .status()
        .expect("git init");
    assert!(made.success(), "could not make the repository under test");
    fs::write(theirs.join("draft.txt"), "mine\n").expect("write");
    let staged = std::process::Command::new("git")
        .args(["add", "draft.txt"])
        .current_dir(&theirs)
        .status()
        .expect("git add");
    assert!(staged.success());

    init(&theirs, true).expect("init --git");

    let log = std::process::Command::new("git")
        .args(["log", "--oneline"])
        .current_dir(&theirs)
        .output()
        .expect("git log");
    // Empty stdout alone would also be what a *broken* repository produces, so
    // the staged file has to still be staged and uncommitted — a positive
    // statement about the state we are protecting rather than an absence.
    assert!(
        log.stdout.is_empty(),
        "committed to a repository we did not create: {}",
        String::from_utf8_lossy(&log.stdout)
    );
    assert!(theirs.join(".git").is_dir(), "their repository is gone");
    let staged = std::process::Command::new("git")
        .args(["diff", "--cached", "--name-only"])
        .current_dir(&theirs)
        .output()
        .expect("git diff");
    assert_eq!(
        String::from_utf8_lossy(&staged.stdout).trim(),
        "draft.txt",
        "their staged work did not survive `init --git`"
    );
}

#[test]
fn a_new_repository_gets_a_baseline_commit() {
    // Without one, `--git` leaves a repository with no commits: the status bar
    // reads DIRTY on a vault nobody has touched, and the first checkpoint
    // quietly becomes the initial import instead of a checkpoint.
    // Forced, so this test means the same thing on a laptop and on a runner.
    // Without it the assertions below hold only where a `user.email` happens to
    // be configured, and CI — the place a regression would actually surface —
    // is exactly where one is not.
    force_a_git_identity();

    let tmp = TempVault::new();
    let repo = tmp.path().join("repo");
    init(&repo, true).expect("init --git");

    // Unconditional, and that is the whole point. This used to read
    // `if !repo.join(".git").is_dir() { return }` — which looks like a
    // reasonable "skip when git is missing" guard and is not one, because a
    // `.git` directory existing *is* part of the outcome under test: making the
    // repository is what `--git` does. Measured: replace the `git init` call in
    // `init_git` with `git --version` and this test returned green with zero
    // assertions run. The same defect the comment below congratulates itself
    // for removing, one step earlier.
    //
    // Git is a hard requirement of this test rather than an optional
    // convenience: `force_a_git_identity` above only means anything if a child
    // git process actually runs.
    assert!(
        repo.join(".git").is_dir(),
        "`init --git` did not create a repository"
    );

    let out = std::process::Command::new("git")
        .args(["log", "--oneline"])
        .current_dir(&repo)
        .output()
        .expect("git log");

    // Unconditional. An earlier version of this test put both assertions behind
    // `if committed`, so deleting the feature it guards left it passing with an
    // empty body — the test was green precisely when the thing under test did
    // not happen. `init` runs with an identity forced below, so "could not
    // commit" is not a state this test tolerates.
    assert!(
        out.status.success() && !out.stdout.is_empty(),
        "no baseline commit: {}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    let dirty = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&repo)
        .output()
        .expect("git status");
    assert!(
        dirty.stdout.is_empty(),
        "the scaffold committed but the vault still reads dirty: {}",
        String::from_utf8_lossy(&dirty.stdout)
    );
}

// ------------------------------------------------------------------------ new

#[test]
fn new_writes_a_conforming_note_and_returns_its_path() {
    let tmp = TempVault::new();
    init(tmp.path(), false).expect("init");
    let vault = tmp.open();

    let rel = create(&vault, "Terminal aesthetics").expect("create");
    assert_eq!(rel, "notes/001-terminal-aesthetics.md");

    let body = fs::read_to_string(tmp.path().join(&rel)).expect("read note");
    assert!(body.contains("\nref: 001\n"));
    assert!(body.contains("\ntitle: Terminal aesthetics\n"));
    assert!(body.contains("\ntags: []\n"));
}

#[test]
fn new_never_reissues_a_ref_a_deleted_note_used() {
    // §04's central invariant: a [[NNN]] link can never be re-pointed by a
    // delete-then-create.
    let tmp = TempVault::new();
    init(tmp.path(), false).expect("init");
    let vault = tmp.open();

    let first = create(&vault, "First").expect("create");
    vault.trash(&first).expect("trash");

    let second = create(&vault, "Second").expect("create");
    assert_eq!(second, "notes/002-second.md");
}

#[test]
fn the_same_title_twice_makes_two_notes_and_clobbers_neither() {
    // The allocator already keeps the paths apart — the ref is in the filename —
    // so this pins that the second call does not reuse the first's name. The
    // `AlreadyExists` guard inside `create` covers only the cross-process race
    // documented in ROADMAP, which is not reachable through this API.
    let tmp = TempVault::new();
    init(tmp.path(), false).expect("init");
    let vault = tmp.open();

    let first = create(&vault, "Taken").expect("first");
    let second = create(&vault, "Taken").expect("second");

    assert_eq!(first, "notes/001-taken.md");
    assert_eq!(second, "notes/002-taken.md");
    for rel in [&first, &second] {
        assert!(
            fs::read_to_string(tmp.path().join(rel))
                .expect("read")
                .contains("title: Taken")
        );
    }
}

#[test]
fn a_title_yaml_cannot_read_plainly_is_quoted_rather_than_lost() {
    // `register new "Rust: a survey"` used to exit 0, print a path, and write a
    // note whose frontmatter no parser could read: a bare `: ` inside a plain
    // scalar is a syntax error, so the block failed whole and the note lost its
    // title *and* its tags everywhere they are drawn. Nothing said so.
    let tmp = TempVault::new();
    let vault = tmp.open();

    for title in [
        "Rust: a survey",
        "trailing colon:",
        "a # hash",
        "[bracketed]",
        "- dashed",
        "quote \" inside",
        "back\\slash",
    ] {
        let rel = create(&vault, title).expect("create");
        let raw = fs::read_to_string(tmp.path().join(&rel)).expect("read");

        // The whole point: it survives the round trip the INDEX actually makes.
        let entry = vault
            .tree()
            .expect("tree")
            .notes
            .into_iter()
            .find(|note| note.path == rel)
            .expect("the note is in the tree");
        assert_eq!(
            entry.title.as_deref(),
            Some(title),
            "title did not survive the frontmatter it was written into:\n{raw}"
        );
    }
}

#[test]
fn an_ordinary_title_is_still_written_plainly() {
    // Quoting only where YAML needs it. §04's examples are unquoted and a vault
    // is meant to read like something a person wrote by hand.
    let tmp = TempVault::new();
    let vault = tmp.open();

    let rel = create(&vault, "Terminal aesthetics").expect("create");
    let raw = fs::read_to_string(tmp.path().join(&rel)).expect("read");
    assert!(
        raw.contains("title: Terminal aesthetics\n"),
        "an unremarkable title was quoted anyway:\n{raw}"
    );
}

// ---------------------------------------------------------------------- slugs

#[test]
fn slugs_match_the_client() {
    // Every case from app/src/core/refs.test.ts, so the same title typed into
    // the UI and passed to the CLI names the same file.
    for (title, expected) in [
        ("Terminal aesthetics", "terminal-aesthetics"),
        ("Terminal  aesthetics!", "terminal-aesthetics"),
        ("  Leading and trailing  ", "leading-and-trailing"),
        ("Café notes", "cafe-notes"),
        ("C++ vs Rust", "c-vs-rust"),
        ("???", "untitled"),
        ("", "untitled"),
        // Any script, not only Latin. These used to slug to `untitled` here
        // while the browser produced a real name from the same title — one
        // title, two filenames, depending where it was typed.
        ("Заметки", "заметки"),
        ("設計ノート", "設計ノート"),
        ("Ελληνικά", "ελληνικά"),
    ] {
        assert_eq!(slug(title), expected, "slug({title:?})");
    }
}

// ----------------------------------------------------------------------- ulid

#[test]
fn a_ulid_is_26_sortable_crockford_characters() {
    let id = ulid(moment());
    assert_eq!(id.len(), 26);
    assert!(
        id.chars().all(|c| ALPHABET.contains(&(c as u8))),
        "{id} is not Crockford base32"
    );
    // No I, L, O or U, so it cannot be misread aloud.
    assert!(!id.contains(['I', 'L', 'O', 'U']));
}

#[test]
fn ulids_sort_by_time() {
    let early = ulid(moment());
    let later = ulid(moment() + Duration::from_millis(1));
    assert!(early[..10] < later[..10], "{early} should precede {later}");
}

#[test]
fn ulids_made_in_the_same_millisecond_still_differ() {
    // The whole point of the random half. A thousand in a tight loop share the
    // timestamp, so any collision here is the entropy failing.
    let ids: HashSet<String> = (0..1000).map(|_| ulid(moment())).collect();
    assert_eq!(ids.len(), 1000);
}

// ---------------------------------------------------------------------- dates

#[test]
fn dates_are_utc_and_survive_leap_years() {
    for (seconds, date, stamp) in [
        (0_i64, "1970-01-01", "1970-01-01T00:00:00Z"),
        // The instant app/src/core/refs.test.ts pins, so both sides agree.
        (1_785_921_400, "2026-08-05", "2026-08-05T09:16:40Z"),
        // 2024-02-29: a leap day in a leap century-rule year.
        (1_709_164_800, "2024-02-29", "2024-02-29T00:00:00Z"),
        // 2000-02-29: divisible by 400, so a leap year.
        (951_782_400, "2000-02-29", "2000-02-29T00:00:00Z"),
        // 1900 was not a leap year; 1900-03-01 must not read as 02-29.
        (-2_203_891_200, "1900-03-01", "1900-03-01T00:00:00Z"),
    ] {
        assert_eq!(iso_date(seconds), date, "iso_date({seconds})");
        assert_eq!(iso_seconds(seconds), stamp, "iso_seconds({seconds})");
    }
}

/// `serve` scaffolds a folder that holds no vault, so pointing the app at one is
/// the whole of setup — and must never scaffold over anything anyone else put
/// there. These pin both halves.
mod holds_a_vault {
    use super::*;

    /// A directory under a temp vault, so nothing here writes outside it.
    fn dir(tmp: &TempVault, name: &str) -> std::path::PathBuf {
        let path = tmp.path().join(name);
        fs::create_dir_all(&path).expect("create dir");
        path
    }

    #[test]
    fn a_folder_that_is_not_there_holds_nothing() {
        // The case that most needs scaffolding: `register serve ~/vault` on a
        // machine that has never run this. It used to be caught by the walk's
        // "cannot read it, assume occupied" rule and refused.
        let tmp = TempVault::new();
        assert!(!holds_a_vault(&tmp.path().join("never-created")));
    }

    #[test]
    fn an_empty_folder_holds_nothing() {
        let tmp = TempVault::new();
        assert!(!holds_a_vault(&dir(&tmp, "empty")));
    }

    #[test]
    fn housekeeping_files_are_not_a_vault() {
        // "Empty" has to mean empty of a *vault*, or the check refuses to help
        // anyone whose folder has been touched by git or the Finder.
        let tmp = TempVault::new();
        let path = dir(&tmp, "housekeeping");
        fs::write(path.join(".DS_Store"), "").expect("write");
        fs::create_dir_all(path.join(".git")).expect("create .git");
        fs::write(path.join("notes.txt"), "not markdown").expect("write");
        assert!(!holds_a_vault(&path));
    }

    #[test]
    fn the_directory_the_app_owns_is_a_vault() {
        // A vault whose notes have all been deleted is still a vault: it has
        // config, a trash folder and a ref counter that must not be reset.
        let tmp = TempVault::new();
        let path = dir(&tmp, "emptied");
        fs::create_dir_all(path.join(APP_DIR)).expect("create .register");
        assert!(holds_a_vault(&path));
    }

    #[test]
    fn markdown_anywhere_is_somebody_writing() {
        let tmp = TempVault::new();
        let shallow = dir(&tmp, "shallow");
        fs::write(shallow.join("theirs.md"), "# theirs").expect("write");
        assert!(holds_a_vault(&shallow));

        // Nested, because a notes folder is the ordinary shape and a check that
        // only looked at the top level would scaffold straight over one.
        let deep = dir(&tmp, "deep");
        fs::create_dir_all(deep.join("a/b/c")).expect("create nested");
        fs::write(deep.join("a/b/c/theirs.md"), "# theirs").expect("write");
        assert!(holds_a_vault(&deep));
    }

    #[test]
    fn the_extension_is_matched_whatever_its_case() {
        let tmp = TempVault::new();
        let path = dir(&tmp, "shouty");
        fs::write(path.join("THEIRS.MD"), "# theirs").expect("write");
        assert!(
            holds_a_vault(&path),
            "a .MD file is still someone's writing"
        );
    }

    #[test]
    fn scaffolding_a_new_folder_leaves_it_holding_a_vault() {
        // The property that makes this safe to run on every serve: it is not
        // idempotent by luck, it is idempotent because the second call sees
        // what the first one wrote.
        let tmp = TempVault::new();
        let path = tmp.path().join("fresh");
        assert!(!holds_a_vault(&path));
        init(&path, false).expect("init");
        assert!(holds_a_vault(&path));
    }
}
