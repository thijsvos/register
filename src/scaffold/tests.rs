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
