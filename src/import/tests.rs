use super::*;
use std::time::Duration;

fn at(seconds: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
}

fn note(rel: &str, text: &str) -> SourceNote {
    let stem = rel
        .rsplit('/')
        .next()
        .unwrap_or(rel)
        .trim_end_matches(".md")
        .to_owned();
    SourceNote {
        rel: rel.to_owned(),
        stem,
        text: text.to_owned(),
        created: at(1_000_000_000),
        modified: at(1_700_000_000),
    }
}

fn ctx(titles: &[(&str, &str)], attachments: &[(&str, &str)]) -> Ctx {
    Ctx {
        titles: titles
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        attachments: attachments
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
    }
}

/// The rewritten body only, for the table below.
fn rewritten(body: &str, ctx: &Ctx) -> String {
    let mut findings = Vec::new();
    rewrite(body, ctx, "Note", &mut findings)
}

// ---------------------------------------------------------------- primitives

#[test]
fn a_ref_widens_rather_than_wrapping_when_the_digits_run_out() {
    assert_eq!(bump("001"), "002");
    assert_eq!(bump("008"), "009");
    // The width is a minimum, exactly as `Vault::next_ref` treats it, so a
    // vault larger than the format grows a column instead of reissuing `000`.
    assert_eq!(bump("999"), "1000");
    assert_eq!(bump("1000"), "1001");
}

#[test]
fn only_a_dated_name_is_a_daily_note() {
    assert!(is_daily("2026-08-21"));
    assert!(!is_daily("2026-8-21"));
    assert!(!is_daily("2026-08-21-notes"));
    assert!(!is_daily("terminal-aesthetics"));
    // §04's other dated shape is a ref, and it is three digits, not ten.
    assert!(!is_daily("003"));
}

#[test]
fn a_nested_obsidian_tag_folds_to_one_lowercase_word() {
    assert_eq!(fold_tag("#Project/Alpha"), "project-alpha");
    assert_eq!(fold_tag("Reading"), "reading");
    assert_eq!(fold_tag("#some_tag"), "some-tag");
    assert_eq!(fold_tag("#"), "");
    // Latin-1 folds the way `scaffold::slug` folds it, so `Café` is one word.
    assert_eq!(fold_tag("#café"), "café");
}

// --------------------------------------------------------------------- title

#[test]
fn a_title_prefers_frontmatter_then_a_heading_then_the_filename() {
    assert_eq!(
        title_of(Some("From frontmatter"), "# From heading\n", "from-stem"),
        "From frontmatter"
    );
    assert_eq!(
        title_of(None, "# From heading\n", "from-stem"),
        "From heading"
    );
    assert_eq!(
        title_of(None, "no heading here\n", "from-stem"),
        "from-stem"
    );
    // An empty frontmatter title is not a title.
    assert_eq!(title_of(Some("   "), "# Heading\n", "stem"), "Heading");
    // `##` is not an H1.
    assert_eq!(title_of(None, "## Second level\n", "stem"), "stem");
}

// ---------------------------------------------------------------------- tags

#[test]
fn tags_are_read_from_every_shape_obsidian_writes_them_in() {
    let list = split("---\ntags: [Alpha, Beta]\n---\nbody\n");
    assert_eq!(tags_of(&list.0, list.1), vec!["alpha", "beta"]);

    let scalar = split("---\ntags: Alpha, Beta\n---\nbody\n");
    assert_eq!(tags_of(&scalar.0, scalar.1), vec!["alpha", "beta"]);

    let block = split("---\ntags:\n  - Alpha\n  - Beta\n---\nbody\n");
    assert_eq!(tags_of(&block.0, block.1), vec!["alpha", "beta"]);
}

#[test]
fn an_inline_tag_is_carried_but_a_heading_and_a_code_sample_are_not() {
    let (front, body) = split("body #reading and more\n");
    assert_eq!(tags_of(&front, body), vec!["reading"]);

    // A leading `#` is a heading. Reading it as a tag would give every note a
    // tag named after its own first line.
    let (front, body) = split("# Heading\ntext\n");
    assert!(tags_of(&front, body).is_empty());

    // A comment in a code sample is not a tag.
    let (front, body) = split("```sh\n# not a tag\necho hi\n```\ntext\n");
    assert!(tags_of(&front, body).is_empty());

    // `C#` is not a tag, and neither is a URL fragment.
    let (front, body) = split("I write C# and read page#anchor\n");
    assert!(tags_of(&front, body).is_empty());

    // `#1` is prose.
    let (front, body) = split("issue #1 is open\n");
    assert!(tags_of(&front, body).is_empty());
}

#[test]
fn frontmatter_that_does_not_parse_costs_the_note_nothing_but_its_metadata() {
    // Same tolerance `vault.rs` shows: a bad block yields the default rather
    // than failing the note, because the body is the thing worth carrying.
    let (front, body) = split("---\ntags: [unclosed\ntitle: x\n---\nthe body\n");
    assert!(front.title.is_none());
    assert_eq!(body, "the body\n");
}

#[test]
fn a_note_with_no_frontmatter_is_all_body() {
    let (front, body) = split("just text\n");
    assert!(front.title.is_none());
    assert_eq!(body, "just text\n");
}

// ------------------------------------------------------- the rewriting table

#[test]
fn a_plain_wikilink_and_an_alias_are_left_exactly_as_they_are() {
    let ctx = ctx(&[("other", "Other")], &[]);
    // These already resolve: `NoteLookup` is ref-then-title, and `WIKILINK`
    // discards the alias. Rewriting them would be churn with no effect.
    assert_eq!(rewritten("see [[Other]]\n", &ctx), "see [[Other]]\n");
    assert_eq!(
        rewritten("see [[Other|the other]]\n", &ctx),
        "see [[Other|the other]]\n"
    );
}

#[test]
fn a_heading_anchor_and_a_folder_path_are_dropped_from_a_wikilink() {
    let ctx = ctx(&[], &[]);
    assert_eq!(rewritten("[[Note#Heading]]\n", &ctx), "[[Note]]\n");
    assert_eq!(rewritten("[[folder/Note]]\n", &ctx), "[[Note]]\n");
    assert_eq!(rewritten("[[deep/folder/Note]]\n", &ctx), "[[Note]]\n");
    // Both at once, alias preserved.
    assert_eq!(
        rewritten("[[folder/Note#H|shown]]\n", &ctx),
        "[[Note|shown]]\n"
    );
}

#[test]
fn an_image_embed_becomes_the_reference_syntax_04_already_parses() {
    let ctx = ctx(&[], &[("diagram.png", "attachments/diagram.png")]);
    assert_eq!(
        rewritten("![[diagram.png]]\n", &ctx),
        "![diagram.png](attachments/diagram.png)\n"
    );
    // Obsidian's size suffix is an alias; the target is what matters.
    assert_eq!(
        rewritten("![[diagram.png|300]]\n", &ctx),
        "![diagram.png](attachments/diagram.png)\n"
    );
}

#[test]
fn a_note_embed_is_left_alone_and_reported_because_04_has_no_form_for_it() {
    let ctx = ctx(&[("some note", "Some Note")], &[]);
    let mut findings = Vec::new();
    let out = rewrite("![[Some Note]]\n", &ctx, "Note", &mut findings);

    // Unchanged — there is nothing to rewrite it *to*.
    assert_eq!(out, "![[Some Note]]\n");
    assert_eq!(findings.len(), 1);
    match &findings[0] {
        Finding::Kept { what, why, .. } => {
            assert_eq!(what, "![[Some Note]]");
            assert!(why.contains("no form"));
        }
        Finding::Rewrote { .. } => panic!("a note embed must not be rewritten"),
    }
}

#[test]
fn a_markdown_link_to_a_note_becomes_a_wikilink_that_keeps_its_text() {
    let ctx = ctx(&[("other", "Other Note")], &[]);
    assert_eq!(
        rewritten("see [the other](other.md)\n", &ctx),
        "see [[Other Note|the other]]\n"
    );
    // Text that only repeats the title is dropped rather than made an alias.
    assert_eq!(
        rewritten("see [Other Note](other.md)\n", &ctx),
        "see [[Other Note]]\n"
    );
    // A path form resolves by its last segment too.
    assert_eq!(
        rewritten("see [x](folder/other.md)\n", &ctx),
        "see [[Other Note|x]]\n"
    );
}

#[test]
fn a_markdown_link_to_something_not_imported_is_left_alone() {
    let ctx = ctx(&[("other", "Other")], &[]);
    // A media reference is already the shape §04 wants.
    assert_eq!(rewritten("![x](img.png)\n", &ctx), "![x](img.png)\n");
    // An external link is not ours to touch.
    assert_eq!(
        rewritten("[docs](https://example.com)\n", &ctx),
        "[docs](https://example.com)\n"
    );
    // A note that was not in the source vault stays a markdown link, reported.
    let mut findings = Vec::new();
    let out = rewrite("[gone](missing.md)\n", &ctx, "Note", &mut findings);
    assert_eq!(out, "[gone](missing.md)\n");
    assert_eq!(findings.len(), 1);
    assert!(matches!(findings[0], Finding::Kept { .. }));
}

#[test]
fn a_link_inside_code_is_prose_about_links_and_is_never_rewritten() {
    let ctx = ctx(&[("other", "Other")], &[]);

    // A fenced block: rewriting here would corrupt the sample it appears in.
    let fenced = "```\n[[folder/Note#H]]\n```\n";
    assert_eq!(rewritten(fenced, &ctx), fenced);

    // A tilde fence is a fence too.
    let tilde = "~~~\n[[folder/Note]]\n~~~\n";
    assert_eq!(rewritten(tilde, &ctx), tilde);

    // An inline span, with a real link on the same line to prove the span is
    // the only thing spared.
    assert_eq!(
        rewritten("`[[folder/A]]` but [[folder/B]]\n", &ctx),
        "`[[folder/A]]` but [[B]]\n"
    );
}

#[test]
fn text_after_a_closed_fence_is_rewritten_again() {
    let ctx = ctx(&[], &[]);
    assert_eq!(
        rewritten("```\n[[folder/A]]\n```\n[[folder/B]]\n", &ctx),
        "```\n[[folder/A]]\n```\n[[B]]\n"
    );
}

#[test]
fn every_rewrite_is_recorded_so_a_change_to_somebody_s_prose_is_auditable() {
    let ctx = ctx(&[("other", "Other")], &[]);
    let mut findings = Vec::new();
    rewrite(
        "[[folder/A#h]] and [x](other.md)\n",
        &ctx,
        "The Note",
        &mut findings,
    );

    assert_eq!(findings.len(), 2);
    for finding in &findings {
        match finding {
            Finding::Rewrote { note, from, to } => {
                assert_eq!(note, "The Note");
                assert_ne!(from, to);
            }
            Finding::Kept { .. } => panic!("both of these resolve"),
        }
    }
}

#[test]
fn multibyte_prose_survives_the_scanner_intact() {
    let ctx = ctx(&[], &[]);
    // The rewriter indexes a `str`, so a body that is not ASCII must come back
    // byte-for-byte rather than sliced through a character.
    let body = "Заметки — café — 日本語 [[folder/Note]]\n";
    assert_eq!(rewritten(body, &ctx), "Заметки — café — 日本語 [[Note]]\n");
}

// ------------------------------------------------------------------ planning

#[test]
fn planning_places_notes_and_dailies_where_04_puts_them() {
    let source = Source {
        notes: vec![
            note(
                "Terminal Aesthetics.md",
                "---\ntitle: Terminal Aesthetics\n---\nbody\n",
            ),
            note("2026-08-21.md", "a daily\n"),
        ],
        attachments: vec![],
    };
    let outcome = plan(&source, "001", &BTreeSet::new());

    let paths: Vec<&str> = outcome.planned.iter().map(|p| p.rel.as_str()).collect();
    assert!(paths.contains(&"notes/001-terminal-aesthetics.md"));
    // A dated note goes to `daily/` and takes no ref, which is what
    // `ref_from_path` already assumes about that directory.
    assert!(paths.contains(&"daily/2026-08-21.md"));
}

#[test]
fn planning_gives_every_note_its_own_ref() {
    let source = Source {
        notes: vec![
            note("a.md", "one\n"),
            note("b.md", "two\n"),
            note("c.md", "three\n"),
        ],
        attachments: vec![],
    };
    let outcome = plan(&source, "007", &BTreeSet::new());

    let refs: Vec<String> = outcome
        .planned
        .iter()
        .filter_map(|p| p.rel.strip_prefix("notes/"))
        .filter_map(|r| r.split('-').next().map(str::to_owned))
        .collect();
    assert_eq!(refs, vec!["007", "008", "009"]);
}

#[test]
fn an_imported_note_keeps_the_dates_it_arrived_with() {
    let source = Source {
        notes: vec![note("a.md", "body\n")],
        attachments: vec![],
    };
    let outcome = plan(&source, "001", &BTreeSet::new());
    let body = &outcome.planned[0].body;

    // 1_000_000_000 is 2001-09-09; the conversion did not invent today.
    assert!(
        body.contains("created: 2001-09-09"),
        "created was not carried: {body}"
    );
    // 1_700_000_000 is 2023-11-14.
    assert!(
        body.contains("modified: 2023-11-14"),
        "modified was not carried: {body}"
    );
}

#[test]
fn a_planned_note_is_a_04_note() {
    let source = Source {
        notes: vec![note(
            "Some Note.md",
            "---\ntitle: Some Note\ntags: [alpha]\n---\nthe body\n",
        )],
        attachments: vec![],
    };
    let outcome = plan(&source, "003", &BTreeSet::new());
    let body = &outcome.planned[0].body;

    for field in ["id: ", "ref: 003", "title: Some Note", "tags: [alpha]"] {
        assert!(body.contains(field), "missing {field:?} in {body}");
    }
    assert!(body.starts_with("---\n"));
    assert!(body.ends_with("the body\n"), "body was not carried: {body}");
}

#[test]
fn a_link_resolves_across_notes_because_planning_titles_them_all_first() {
    let source = Source {
        notes: vec![
            note("a.md", "see [there](folder/b.md)\n"),
            note("folder/b.md", "---\ntitle: The Target\n---\nhi\n"),
        ],
        attachments: vec![],
    };
    let outcome = plan(&source, "001", &BTreeSet::new());
    let first = outcome
        .planned
        .iter()
        .find(|p| p.rel.ends_with("-a.md"))
        .expect("a.md was planned");

    // Only possible because pass one titled `folder/b.md` before pass two
    // rewrote `a.md`.
    assert!(
        first.body.contains("[[The Target|there]]"),
        "link did not resolve: {}",
        first.body
    );
}

// ----------------------------------------------------------------- the report

#[test]
fn the_report_names_every_note_it_mentions_so_it_can_be_navigated() {
    let source = Source {
        notes: vec![note("a.md", "![[Some Note]] and [[folder/B#h]]\n")],
        attachments: vec![],
    };
    let outcome = plan(&source, "001", &BTreeSet::new());
    let report = report(&outcome);

    assert!(report.contains("Not carried"), "{report}");
    assert!(report.contains("Rewritten"), "{report}");
    // Every entry links its note, so the report is usable in the app rather
    // than being a list of names to go and search for.
    assert!(report.contains("[[a]]"), "{report}");
    assert!(report.contains("![[Some Note]]"), "{report}");
}

#[test]
fn a_clean_import_reports_no_residue_sections() {
    let source = Source {
        notes: vec![note("a.md", "plain prose with [[B]]\n")],
        attachments: vec![],
    };
    let outcome = plan(&source, "001", &BTreeSet::new());
    let report = report(&outcome);

    // A clean conversion must not print empty headings — a section that is
    // always there says nothing about the import it describes.
    assert!(!report.contains("Not carried"), "{report}");
    assert!(!report.contains("Rewritten"), "{report}");
    assert!(report.contains("1 note "), "{report}");
}

#[test]
fn an_imported_daily_carries_no_ref_and_the_tag_the_template_uses() {
    let source = Source {
        notes: vec![note("2026-08-21.md", "- woke up\n")],
        attachments: vec![],
    };
    let outcome = plan(&source, "001", &BTreeSet::new());
    let body = &outcome.planned[0].body;

    // §04 gives `daily/YYYY-MM-DD.md` no ref, and `ref_from_path` declines to
    // read one there. An empty `ref:` is a field §04 says the file does not
    // have — it shipped that way until a real import was read by eye.
    assert!(
        !body.contains("ref:"),
        "a daily note must carry no ref at all: {body}"
    );
    assert!(body.contains("tags: [daily]"), "not tagged daily: {body}");
    assert!(body.contains("title: 2026-08-21"), "{body}");
}

#[test]
fn an_imported_note_still_carries_its_ref() {
    let source = Source {
        notes: vec![note("a.md", "body\n")],
        attachments: vec![],
    };
    let outcome = plan(&source, "004", &BTreeSet::new());
    // The other half of the rule above: dropping the empty line must not drop
    // the populated one.
    assert!(
        outcome.planned[0].body.contains("ref: 004"),
        "{}",
        outcome.planned[0].body
    );
}
