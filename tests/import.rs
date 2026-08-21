//! `register import`, driven the way somebody actually runs it.
//!
//! The unit tests in `src/import/tests.rs` check the translation table a row at
//! a time against strings. This checks that the binary, given a folder on a
//! real disk, leaves a vault the rest of the product can read — which is the
//! only claim that matters to whoever is converting their notes.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const BINARY: &str = env!("CARGO_BIN_EXE_register");

fn scratch(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("register-import-{name}-{nanos:x}"));
    fs::create_dir_all(&path).expect("create scratch");
    path.canonicalize().expect("canonicalize scratch")
}

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/obsidian-v1")
}

fn register(args: &[&str]) -> String {
    let out = Command::new(BINARY)
        .args(args)
        .output()
        .expect("run register");
    assert!(
        out.status.success(),
        "register {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Every note in the imported vault, as `(relative path, body)`.
fn notes(root: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            walk(root, &path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let rel = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            out.push((rel, fs::read_to_string(&path).unwrap_or_default()));
        }
    }
}

fn body_of<'a>(notes: &'a [(String, String)], contains: &str) -> &'a str {
    notes
        .iter()
        .find(|(rel, _)| rel.contains(contains))
        .map(|(_, body)| body.as_str())
        .unwrap_or_else(|| panic!("no note matching {contains:?} in {:?}", paths(notes)))
}

fn paths(notes: &[(String, String)]) -> Vec<&str> {
    notes.iter().map(|(rel, _)| rel.as_str()).collect()
}

// -------------------------------------------------------------------- the run

#[test]
fn an_obsidian_vault_converts_into_one_the_product_can_read() {
    let out = scratch("full");
    let said = register(&[
        "import",
        &fixture().to_string_lossy(),
        &out.to_string_lossy(),
    ]);
    let notes = notes(&out);

    // The destination was empty, so `import` scaffolded it — the same courtesy
    // `serve` extends, and the reason this is one command rather than two.
    assert!(out.join(".register").is_dir(), "no vault was scaffolded");
    assert!(
        out.join("CLAUDE.md").is_file(),
        "the agent contract is what makes it a §04 vault"
    );

    // Nine source notes plus the scaffold's inbox plus the report.
    assert!(notes.len() >= 10, "too few notes: {:?}", paths(&notes));
    assert!(said.contains("See notes/"), "no report was named: {said}");

    // A dated name is a daily note and takes no ref.
    assert!(
        notes.iter().any(|(rel, _)| rel == "daily/2026-08-21.md"),
        "the daily did not land in daily/: {:?}",
        paths(&notes)
    );

    // Every other note is `notes/NNN-slug.md`, and every ref is unique — the
    // §04 promise that a ref is allocated once and never reissued.
    let mut refs: Vec<String> = notes
        .iter()
        .filter_map(|(rel, _)| rel.strip_prefix("notes/"))
        .filter_map(|r| r.split('-').next().map(str::to_owned))
        .collect();
    let before = refs.len();
    refs.sort();
    refs.dedup();
    assert_eq!(before, refs.len(), "a ref was issued twice: {refs:?}");
}

#[test]
fn the_source_vault_is_not_touched() {
    let out = scratch("readonly");
    let before = snapshot(&fixture());

    register(&[
        "import",
        &fixture().to_string_lossy(),
        &out.to_string_lossy(),
    ]);

    // §12 says "one-way converters". A converter that edits the thing it is
    // reading is not one, and this fixture is checked into the repository —
    // so a regression here shows up as a dirty working tree too.
    assert_eq!(before, snapshot(&fixture()), "the source vault changed");
}

fn snapshot(root: &Path) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            out.push((path.to_string_lossy().into_owned(), meta.len()));
        }
    }
    out.sort();
    out
}

#[test]
fn a_dry_run_writes_nothing_and_says_what_it_would_have_done() {
    let out = scratch("dry");
    let said = register(&[
        "import",
        &fixture().to_string_lossy(),
        &out.to_string_lossy(),
        "--dry-run",
    ]);

    assert!(said.contains("--dry-run"), "did not say it was dry: {said}");
    // Not one file, not even the scaffold: a dry run that creates a vault has
    // already changed the thing it was asked only to describe.
    assert!(
        fs::read_dir(&out).into_iter().flatten().flatten().count() == 0,
        "a dry run wrote into the destination"
    );
    // And it still reports, because a report nobody can read before committing
    // to the import is a report that arrives too late to be useful.
    assert!(said.contains("Not carried"), "no residue reported: {said}");
}

// ---------------------------------------------------------- the ruling, e2e

#[test]
fn links_arrive_in_the_forms_04_resolves() {
    let out = scratch("links");
    register(&[
        "import",
        &fixture().to_string_lossy(),
        &out.to_string_lossy(),
    ]);
    let notes = notes(&out);

    // `[[folder/Nested Note#Section]]` → `[[Nested Note]]`, and the alias form
    // keeps its alias.
    let aesthetics = body_of(&notes, "terminal-aesthetics");
    assert!(
        aesthetics.contains("[[Nested Note]]"),
        "anchor and folder were not dropped: {aesthetics}"
    );
    assert!(
        aesthetics.contains("[[Reading List|the list]]"),
        "an already-resolving link was disturbed: {aesthetics}"
    );

    // `[the nested one](folder/Nested Note.md)` → `[[Nested Note|the nested one]]`.
    let reading = body_of(&notes, "reading-list");
    assert!(
        reading.contains("[[Nested Note|the nested one]]"),
        "a markdown link to a note was not converted: {reading}"
    );
}

#[test]
fn a_code_sample_about_links_is_still_a_code_sample() {
    let out = scratch("code");
    register(&[
        "import",
        &fixture().to_string_lossy(),
        &out.to_string_lossy(),
    ]);
    let sample = body_of(&notes(&out), "code-sample").to_owned();

    // Inside the fence and inside the span, untouched.
    assert!(
        sample.contains("This [[folder/Nested Note]] is a sample"),
        "a fenced sample was rewritten: {sample}"
    );
    assert!(
        sample.contains("`[[folder/Nested Note]]`"),
        "an inline span was rewritten: {sample}"
    );
    // Outside them, rewritten — so the test is about the fence and not about
    // the rewriter having quietly stopped working.
    assert!(
        sample.contains("Prose link: [[Nested Note]]"),
        "prose was not rewritten: {sample}"
    );
}

#[test]
fn an_image_embed_becomes_a_reference_and_its_file_comes_with_it() {
    let out = scratch("media");
    register(&[
        "import",
        &fixture().to_string_lossy(),
        &out.to_string_lossy(),
    ]);

    let embeds = body_of(&notes(&out), "embeds").to_owned();
    assert!(
        embeds.contains("![diagram.png](attachments/diagram.png)"),
        "the embed was not converted: {embeds}"
    );
    // The reference is only true if the bytes arrived.
    let copied = out.join("attachments/diagram.png");
    assert!(copied.is_file(), "the attachment was not copied");
    assert_eq!(
        fs::read(&copied).expect("read copied"),
        fs::read(fixture().join("attachments/diagram.png")).expect("read source"),
        "the attachment did not survive the copy"
    );
}

#[test]
fn what_could_not_be_carried_is_a_note_in_the_vault_and_not_a_line_that_scrolled_past() {
    let out = scratch("report");
    register(&[
        "import",
        &fixture().to_string_lossy(),
        &out.to_string_lossy(),
    ]);
    let notes = notes(&out);
    let report = body_of(&notes, "import-report").to_owned();

    // The report is a §04 note, so the app draws it like any other.
    assert!(
        report.starts_with("---\n"),
        "the report is not a note: {report}"
    );
    assert!(report.contains("ref: "), "the report has no ref: {report}");

    // A note embed has no §04 form, so it must appear here rather than vanish.
    assert!(
        report.contains("![[Terminal Aesthetics]]"),
        "the note embed was dropped silently: {report}"
    );
    // And the rewrites are listed, because they changed somebody's prose.
    assert!(report.contains("Rewritten"), "no rewrites listed: {report}");

    // Every note it names is linked, so the residue is navigable in the app.
    assert!(report.contains("[["), "the report links nothing: {report}");
}

#[test]
fn importing_twice_adds_nothing_the_second_time() {
    let out = scratch("twice");
    let args = [
        "import".to_owned(),
        fixture().to_string_lossy().into_owned(),
        out.to_string_lossy().into_owned(),
    ];
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();

    register(&borrowed);
    let first = notes(&out);
    register(&borrowed);
    let second = notes(&out);

    // Notes are never overwritten, which is the rule `init` keeps. The second
    // run allocates fresh refs and finds every path taken, so the only thing it
    // adds is its own report — an import that silently doubled a vault would be
    // the worst possible way to find this out.
    assert_eq!(
        second.len(),
        first.len() + 1,
        "a second import was not a near no-op: {:?}",
        paths(&second)
    );
}

#[test]
fn a_folder_that_is_not_a_vault_is_refused_rather_than_half_converted() {
    let empty = scratch("empty");
    let out = Command::new(BINARY)
        .args([
            "import",
            &empty.to_string_lossy(),
            &scratch("dest").to_string_lossy(),
        ])
        .output()
        .expect("run register");

    assert!(!out.status.success(), "an empty source should fail");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("no markdown"),
        "the refusal does not say why: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn a_vault_cannot_be_imported_into_itself() {
    let both = scratch("same");
    fs::write(both.join("a.md"), "a note\n").expect("write");

    let out = Command::new(BINARY)
        .args(["import", &both.to_string_lossy(), &both.to_string_lossy()])
        .output()
        .expect("run register");

    assert!(!out.status.success(), "importing in place should fail");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("same folder"),
        "the refusal does not say why: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}
