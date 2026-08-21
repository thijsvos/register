//! `register import` — one-way conversion of an Obsidian vault into §04.
//!
//! §12 lists importers as the one expansion row gated on nothing, and four
//! parked entries name it as their own trigger. This is that row for Obsidian,
//! the format all four of them mention.
//!
//! Three properties the rest of this file exists to keep:
//!
//! **The source is read-only.** Nothing here opens a file in the source vault
//! for writing. Somebody handing this their notes is handing over a copy, not
//! custody, and §12's own wording is "one-way converters".
//!
//! **Links are normalised on the way in.** `[[Note#Heading]]`, `[[folder/Note]]`
//! and `[text](other.md)` are rewritten into forms §04 resolves. That is a
//! ruling: `docs/ROADMAP.md` parked the markdown-link question as "a §04
//! question about whether the app rewrites your prose", and this answers it for
//! import only. An existing vault is never rewritten — the blast radius is the
//! conversion itself, and every rewrite is named in the report.
//!
//! **What could not be carried is written down, in the vault.** A converter that
//! drops a construct silently leaves you comparing two vaults by hand to find
//! out. §02b's rule is that no gauge may show a number the system cannot
//! measure; the same honesty applied here means the residue is a note, with
//! links, in the vault you just filled.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::Path;
use std::time::SystemTime;

use crate::scaffold;
use crate::vault::{self, Vault};

/// Extensions `GET /api/file` will serve (§04's allowlist, by container).
/// An `![[embed]]` naming one of these is an image reference; anything else is
/// a note embed, which §04 has no form for.
const MEDIA_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "pdf", "svg"];

/// A note as it exists in the source vault.
pub struct SourceNote {
    /// Path relative to the source root, `/`-separated.
    pub rel: String,
    /// Filename without `.md`. Obsidian links notes by this.
    pub stem: String,
    pub text: String,
    pub created: SystemTime,
    pub modified: SystemTime,
}

/// Everything the source vault holds that this converter has an opinion about.
pub struct Source {
    pub notes: Vec<SourceNote>,
    /// Non-note files, by relative path.
    pub attachments: Vec<String>,
}

/// A finished §04 note and where it goes.
pub struct Planned {
    pub rel: String,
    pub body: String,
}

/// Something the conversion changed, or could not carry.
///
/// Both are reported. A rewrite is not a failure, but it is a change to
/// somebody's prose, and they are entitled to a list of them.
pub enum Finding {
    Rewrote {
        note: String,
        from: String,
        to: String,
    },
    Kept {
        note: String,
        what: String,
        why: &'static str,
    },
}

/// The whole conversion, decided but not yet written.
#[derive(Default)]
pub struct Outcome {
    pub planned: Vec<Planned>,
    /// `(source rel, destination rel)`.
    pub attachments: Vec<(String, String)>,
    pub findings: Vec<Finding>,
}

impl Outcome {
    pub fn rewrites(&self) -> usize {
        self.findings
            .iter()
            .filter(|f| matches!(f, Finding::Rewrote { .. }))
            .count()
    }

    pub fn kept(&self) -> usize {
        self.findings
            .iter()
            .filter(|f| matches!(f, Finding::Kept { .. }))
            .count()
    }
}

/// Obsidian's frontmatter, as much of it as §04 has somewhere to put.
///
/// Every field optional and unknown keys ignored: this parses files written by
/// a different program over years, and a plugin's stray key must not cost the
/// note its title. A block that does not parse at all yields the default, which
/// is the same tolerance `parse_frontmatter` shows in `vault.rs` and for the
/// same reason.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct Front {
    title: Option<String>,
    tags: Option<Tags>,
}

/// `tags: [a, b]`, `tags:\n  - a`, and `tags: a, b` are all in the wild.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum Tags {
    One(String),
    Many(Vec<String>),
}

// ------------------------------------------------------------------- reading

/// Walk the source vault.
///
/// Skips dotted names the way `Vault::walk` does — one rule that covers
/// `.obsidian/`, `.trash/` and every editor swap file at once.
pub fn read(root: &Path) -> io::Result<Source> {
    let mut source = Source {
        notes: Vec::new(),
        attachments: Vec::new(),
    };
    walk(root, root, &mut source)?;
    source.notes.sort_by(|a, b| a.rel.cmp(&b.rel));
    source.attachments.sort();
    Ok(source)
}

fn walk(root: &Path, dir: &Path, out: &mut Source) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        // `DirEntry::metadata` does not traverse symlinks, so a link to a
        // directory is neither walked nor mistaken for one.
        let Ok(meta) = entry.metadata() else { continue };

        if meta.is_dir() {
            walk(root, &path, out)?;
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let Some(rel) = relative(root, &path) else {
            continue;
        };

        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            out.attachments.push(rel);
            continue;
        }
        // A note that cannot be read is skipped rather than fatal, matching the
        // rule `Vault::walk` states: one unreadable file must not take down the
        // whole conversion.
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let stem = rel
            .rsplit('/')
            .next()
            .unwrap_or(&rel)
            .trim_end_matches(".md")
            .to_owned();
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        out.notes.push(SourceNote {
            created: meta.created().unwrap_or(modified),
            rel,
            stem,
            text,
            modified,
        });
    }
    Ok(())
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut out = String::new();
    for part in rel.components() {
        let part = part.as_os_str().to_str()?;
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(part);
    }
    Some(out)
}

// ------------------------------------------------------------------ planning

/// Decide the whole conversion without touching a disk.
///
/// Pure so the translation table can be tested a row at a time, which is the
/// convention `Checkpointer::with_idle` already sets in `git.rs`.
///
/// Two passes, and it has to be two: a link can name any note, so nothing can
/// be rewritten until every note knows its own title.
pub fn plan(source: &Source, first_ref: &str, taken: &BTreeSet<String>) -> Outcome {
    let mut outcome = Outcome::default();

    // Pass one — where everything lands.
    let mut reference = first_ref.to_owned();
    let mut titled: Vec<(&SourceNote, String, Option<String>, String)> = Vec::new();

    for note in &source.notes {
        let (front, body) = split(&note.text);
        let title = title_of(front.title.as_deref(), body, &note.stem);

        // A note already in the vault is left exactly as it is, and does not
        // consume a ref. Without this a second import writes every note again
        // under fresh refs — nothing collides, so nothing refuses, and the
        // vault quietly doubles. Identity is the slug rather than the source
        // path because §04 stores no record of where a note came from, and
        // inventing a field to hold one would be a §04 change.
        let identity = identity_of(&note.stem, &title);
        if taken.contains(&identity) {
            outcome.findings.push(Finding::Kept {
                note: title.clone(),
                what: note.rel.clone(),
                why: "a note with this name is already in the vault",
            });
            continue;
        }

        let (rel, carried) = if is_daily(&note.stem) {
            // §04 gives dated notes their own directory and no ref, and
            // `ref_from_path` already declines to read one there.
            (format!("daily/{}.md", note.stem), None)
        } else {
            let rel = format!("notes/{reference}-{}.md", scaffold::slug(&title));
            let this = reference.clone();
            reference = bump(&reference);
            (rel, Some(this))
        };
        titled.push((note, title, carried, rel));
    }

    let ctx = Ctx {
        titles: titled
            .iter()
            .flat_map(|(note, title, _, _)| {
                // Obsidian resolves `[[Note]]` by filename and `[[folder/Note]]`
                // by path, so both spellings have to answer.
                let stem = note.stem.to_lowercase();
                let path = note.rel.trim_end_matches(".md").to_lowercase();
                [(stem, title.clone()), (path, title.clone())]
            })
            .collect(),
        attachments: source
            .attachments
            .iter()
            .filter_map(|rel| {
                let name = rel.rsplit('/').next()?;
                Some((name.to_lowercase(), rel.clone()))
            })
            .collect(),
    };

    // Pass two — the bodies.
    for (note, title, carried, rel) in &titled {
        let (front, body) = split(&note.text);
        let mut tags = tags_of(&front, body);
        // What `templates/daily.md` puts on one, so an imported day is found by
        // the same tag as a day this app created.
        if carried.is_none() && !tags.iter().any(|t| t == "daily") {
            tags.insert(0, "daily".to_owned());
        }
        let rewritten = rewrite(body, &ctx, title, &mut outcome.findings);
        let tags: Vec<&str> = tags.iter().map(String::as_str).collect();

        outcome.planned.push(Planned {
            rel: rel.clone(),
            body: scaffold::note(
                carried.as_deref().unwrap_or(""),
                title,
                &tags,
                rewritten.trim_start_matches('\n'),
                note.created,
                note.modified,
                None,
            ),
        });
    }

    outcome.attachments = source
        .attachments
        .iter()
        .filter(|rel| !taken.contains(&format!("file:{}", rel.to_lowercase())))
        .map(|rel| (rel.clone(), rel.clone()))
        .collect();

    outcome
}

/// How a source note is recognised in a vault that may already hold it.
///
/// Stated here rather than at the call site so the set the caller builds and
/// the set `plan` tests against cannot drift into two different rules.
pub fn identity_of(stem: &str, title: &str) -> String {
    if is_daily(stem) {
        format!("daily:{stem}")
    } else {
        format!("note:{}", scaffold::slug(title))
    }
}

/// The identity of a note already in the vault, from its §04 path.
pub fn identity_of_existing(rel: &str) -> Option<String> {
    let name = rel.rsplit('/').next()?.trim_end_matches(".md");
    if let Some(stem) = rel.strip_prefix("daily/") {
        return Some(format!("daily:{}", stem.trim_end_matches(".md")));
    }
    if rel.starts_with("notes/") {
        // `007-terminal-aesthetics` → `terminal-aesthetics`.
        let slug = name.split_once('-').map_or(name, |(_, rest)| rest);
        return Some(format!("note:{slug}"));
    }
    None
}

/// What a link may resolve to.
struct Ctx {
    /// Lowercased stem *and* lowercased path, both to the canonical title.
    titles: BTreeMap<String, String>,
    /// Lowercased filename to its path in the vault.
    attachments: BTreeMap<String, String>,
}

fn split(text: &str) -> (Front, &str) {
    let (front, body) = vault::split_note(text);
    let parsed = front
        .and_then(|yaml| serde_saphyr::from_str::<Front>(yaml).ok())
        .unwrap_or_default();
    (parsed, body)
}

/// Frontmatter, then the first `# ` heading, then the filename.
///
/// The heading is second because Obsidian vaults commonly repeat the filename
/// as an H1 and just as commonly do not; the filename is last because it always
/// exists and is always the weakest evidence.
fn title_of(front: Option<&str>, body: &str, stem: &str) -> String {
    if let Some(title) = front.map(str::trim).filter(|t| !t.is_empty()) {
        return title.to_owned();
    }
    for line in body.lines() {
        if let Some(heading) = line.strip_prefix("# ") {
            let heading = heading.trim();
            if !heading.is_empty() {
                return heading.to_owned();
            }
        }
    }
    stem.to_owned()
}

/// Frontmatter tags plus inline `#tag`s, folded to §04's shape.
fn tags_of(front: &Front, body: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();

    let mut take = |raw: &str| {
        let tag = fold_tag(raw);
        if !tag.is_empty() && seen.insert(tag.clone()) {
            out.push(tag);
        }
    };

    match &front.tags {
        Some(Tags::Many(list)) => list.iter().for_each(|t| take(t)),
        // `tags: a, b` — one scalar holding several.
        Some(Tags::One(one)) => one
            .split([',', ' '])
            .filter(|t| !t.is_empty())
            .for_each(&mut take),
        None => {}
    }
    for raw in inline_tags(body) {
        take(&raw);
    }
    out
}

/// `#Project/Alpha` → `project-alpha`.
///
/// §04 says tags are lowercase words. Obsidian's nesting separator has no §04
/// meaning, so it folds to the separator §04 does use rather than being dropped
/// — `project-alpha` keeps the distinction `project` and `alpha` would lose.
fn fold_tag(raw: &str) -> String {
    let mut out = String::new();
    let mut pending = false;
    for ch in raw.trim().trim_start_matches('#').chars() {
        for ch in ch.to_lowercase() {
            if ch.is_alphanumeric() {
                if pending && !out.is_empty() {
                    out.push('-');
                }
                pending = false;
                out.push(ch);
            } else {
                pending = true;
            }
        }
    }
    out
}

/// Inline `#tag`s, outside fenced code.
///
/// A fence toggle rather than a full parse: the cost of missing one is a tag
/// that was not carried, and the cost of a false positive is a tag invented out
/// of a comment in a code sample. The toggle is what keeps the second from
/// happening, which is the one worth preventing.
fn inline_tags(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fenced = false;

    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced || trimmed.starts_with('#') {
            // A leading `#` is a heading, not a tag.
            continue;
        }
        let bytes = line.as_bytes();
        for (nth, _) in line.match_indices('#') {
            // Only at a word boundary: `C#` and `page#anchor` are not tags.
            if nth > 0 && !bytes[nth - 1].is_ascii_whitespace() {
                continue;
            }
            let rest = &line[nth + 1..];
            let end = rest
                .find(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_' || c == '/'))
                .unwrap_or(rest.len());
            let tag = &rest[..end];
            // Must start with a letter, so `#1` in prose is not a tag.
            if tag.starts_with(|c: char| c.is_alphabetic()) {
                out.push(tag.to_owned());
            }
        }
    }
    out
}

/// `007` → `008`, widening when the digits run out.
///
/// The same rule `Vault::next_ref` uses, for the same reason: the width is a
/// minimum, so a vault larger than the format simply grows one column.
fn bump(reference: &str) -> String {
    let width = reference.len();
    let next = reference.parse::<u64>().unwrap_or(0) + 1;
    format!("{next:0width$}")
}

fn is_daily(stem: &str) -> bool {
    let b = stem.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[8..].iter().all(u8::is_ascii_digit)
}

fn is_media(target: &str) -> bool {
    let ext = target.rsplit('.').next().unwrap_or("").to_lowercase();
    MEDIA_EXT.contains(&ext.as_str())
}

// ------------------------------------------------------------------ rewriting

/// Normalise every link in one note.
///
/// Line-oriented with a fence toggle, and backtick-aware within a line, because
/// a `[[link]]` inside a code sample is prose about links rather than a link —
/// rewriting it would corrupt the sample it appears in.
fn rewrite(body: &str, ctx: &Ctx, note: &str, findings: &mut Vec<Finding>) -> String {
    let mut out = String::with_capacity(body.len());
    let mut fenced = false;

    for (nth, line) in body.split_inclusive('\n').enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            out.push_str(line);
            continue;
        }
        if fenced {
            out.push_str(line);
            continue;
        }
        let _ = nth;
        out.push_str(&rewrite_line(line, ctx, note, findings));
    }
    out
}

fn rewrite_line(line: &str, ctx: &Ctx, note: &str, findings: &mut Vec<Finding>) -> String {
    let mut out = String::with_capacity(line.len());
    let bytes = line.as_bytes();
    let mut i = 0usize;

    while i < line.len() {
        // Inline code spans are copied whole for the same reason fences are.
        if bytes[i] == b'`' {
            let rest = &line[i + 1..];
            if let Some(end) = rest.find('`') {
                out.push_str(&line[i..=i + 1 + end]);
                i += end + 2;
                continue;
            }
        }
        if line[i..].starts_with("![[")
            && let Some(end) = line[i..].find("]]")
        {
            let inner = &line[i + 3..i + end];
            out.push_str(&embed(inner, ctx, note, findings));
            i += end + 2;
            continue;
        }
        if line[i..].starts_with("[[")
            && let Some(end) = line[i..].find("]]")
        {
            let inner = &line[i + 2..i + end];
            out.push_str(&wikilink(inner, note, findings));
            i += end + 2;
            continue;
        }
        if bytes[i] == b'['
            && !(i > 0 && bytes[i - 1] == b'!')
            && let Some(rewritten) = markdown_link(&line[i..], ctx, note, findings)
        {
            out.push_str(&rewritten.0);
            i += rewritten.1;
            continue;
        }
        // Push one whole character, never one byte — `i` indexes a `str`.
        let ch = line[i..].chars().next().unwrap_or('\u{fffd}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// `[[folder/Note#Heading|alias]]` → `[[Note|alias]]`.
///
/// The anchor and the folder both go: §04 addresses a note by ref or by title
/// and has no third form, so a link carrying either resolves to nothing at all.
/// Dropping them is what makes the link work; keeping them is what made it a
/// parked entry.
fn wikilink(inner: &str, note: &str, findings: &mut Vec<Finding>) -> String {
    let (target, alias) = match inner.split_once('|') {
        Some((t, a)) => (t, Some(a)),
        None => (inner, None),
    };
    let base = target
        .split('#')
        .next()
        .unwrap_or(target)
        .rsplit('/')
        .next()
        .unwrap_or(target)
        .trim();

    let rebuilt = match alias {
        Some(alias) => format!("[[{base}|{alias}]]"),
        None => format!("[[{base}]]"),
    };
    let original = format!("[[{inner}]]");
    if rebuilt != original {
        findings.push(Finding::Rewrote {
            note: note.to_owned(),
            from: original,
            to: rebuilt.clone(),
        });
    }
    rebuilt
}

/// `![[diagram.png]]` → `![diagram.png](diagram.png)`; `![[Some Note]]` stays.
fn embed(inner: &str, ctx: &Ctx, note: &str, findings: &mut Vec<Finding>) -> String {
    let target = inner.split('|').next().unwrap_or(inner).trim();
    let key = target.rsplit('/').next().unwrap_or(target).to_lowercase();

    if let Some(dest) = ctx.attachments.get(&key) {
        let rebuilt = format!("![{target}]({dest})");
        findings.push(Finding::Rewrote {
            note: note.to_owned(),
            from: format!("![[{inner}]]"),
            to: rebuilt.clone(),
        });
        return rebuilt;
    }
    let why = if is_media(target) {
        "the embedded file is not in the source vault"
    } else {
        "§04 has no form for embedding one note inside another"
    };
    findings.push(Finding::Kept {
        note: note.to_owned(),
        what: format!("![[{inner}]]"),
        why,
    });
    format!("![[{inner}]]")
}

/// `[text](other.md)` → `[[Title|text]]`.
///
/// Returns the replacement and how many bytes of the input it consumed, or
/// `None` when this is not a markdown link to a note in the import set — in
/// which case the caller copies the `[` and moves on.
fn markdown_link(
    at: &str,
    ctx: &Ctx,
    note: &str,
    findings: &mut Vec<Finding>,
) -> Option<(String, usize)> {
    let close = at.find("](")?;
    let text = &at[1..close];
    if text.contains('[') || text.contains('\n') {
        return None;
    }
    let rest = &at[close + 2..];
    let end = rest.find(')')?;
    let target = &rest[..end];
    let consumed = close + 2 + end + 1;

    // Only note links. A media reference is already the form §04 wants.
    let path = target.split('#').next().unwrap_or(target).trim();
    if !path.to_lowercase().ends_with(".md") {
        return None;
    }
    let key = path.trim_end_matches(".md").trim_end_matches(".MD");
    let title = ctx
        .titles
        .get(&key.to_lowercase())
        .or_else(|| {
            let name = key.rsplit('/').next()?;
            ctx.titles.get(&name.to_lowercase())
        })
        .cloned();

    let Some(title) = title else {
        findings.push(Finding::Kept {
            note: note.to_owned(),
            what: at[..consumed].to_owned(),
            why: "the note it links to is not in the source vault",
        });
        return None;
    };

    // The link text is kept as an alias unless it was only repeating the title.
    let rebuilt = if text.trim().eq_ignore_ascii_case(title.trim()) || text.trim().is_empty() {
        format!("[[{title}]]")
    } else {
        format!("[[{title}|{text}]]")
    };
    findings.push(Finding::Rewrote {
        note: note.to_owned(),
        from: at[..consumed].to_owned(),
        to: rebuilt.clone(),
    });
    Some((rebuilt, consumed))
}

// ------------------------------------------------------------------- applying

/// Write the conversion into the vault.
///
/// Every note through `Vault::write` and every attachment through
/// `Vault::write_bytes`, so hard rule 5 holds for an import exactly as it does
/// for a save. Nothing is overwritten: a path already in the vault is left
/// alone and reported, matching the rule `init` keeps.
pub fn apply(vault: &Vault, source_root: &Path, outcome: &Outcome) -> io::Result<usize> {
    let mut written = 0usize;

    for planned in &outcome.planned {
        if vault.root().join(&planned.rel).exists() {
            continue;
        }
        vault
            .write(&planned.rel, &planned.body, None)
            .map_err(|e| io::Error::other(format!("write {}: {e}", planned.rel)))?;
        written += 1;
    }

    for (from, to) in &outcome.attachments {
        if vault.root().join(to).exists() {
            continue;
        }
        let bytes = match fs::read(source_root.join(from)) {
            Ok(bytes) => bytes,
            // An attachment that cannot be read is not worth failing an import
            // that has already written notes; the reference simply goes inert,
            // which is a state §04 already draws.
            Err(_) => continue,
        };
        vault
            .write_bytes(to, &bytes)
            .map_err(|e| io::Error::other(format!("write {to}: {e}")))?;
        written += 1;
    }

    Ok(written)
}

// ------------------------------------------------------------------ reporting

/// The residue, as a note.
///
/// Written into the vault rather than printed, because a terminal scrolls and a
/// note does not — and because every entry names a note, which means the report
/// is navigable in the app the import just filled.
fn count(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The one-line tally, written once so the terminal and the report cannot
/// disagree about what just happened.
pub fn summary(outcome: &Outcome) -> String {
    format!(
        "{} and {} converted. {} rewritten, {} not carried.",
        count(outcome.planned.len(), "note", "notes"),
        count(outcome.attachments.len(), "file", "files"),
        count(outcome.rewrites(), "link", "links"),
        count(outcome.kept(), "thing", "things"),
    )
}

pub fn report(outcome: &Outcome) -> String {
    let mut out = String::new();

    out.push_str(&summary(outcome));
    out.push('\n');

    let mut kept: BTreeMap<&str, Vec<(&str, &str)>> = BTreeMap::new();
    for finding in &outcome.findings {
        if let Finding::Kept { note, what, why } = finding {
            kept.entry(why).or_default().push((note, what));
        }
    }
    if !kept.is_empty() {
        out.push_str("\n## Not carried\n");
        for (why, items) in &kept {
            out.push_str(&format!("\n{why}:\n\n"));
            for (note, what) in items {
                out.push_str(&format!("- `{what}` in [[{note}]]\n"));
            }
        }
    }

    let mut rewrote: BTreeMap<&str, Vec<(&str, &str)>> = BTreeMap::new();
    for finding in &outcome.findings {
        if let Finding::Rewrote { note, from, to } = finding {
            rewrote.entry(note).or_default().push((from, to));
        }
    }
    if !rewrote.is_empty() {
        out.push_str(
            "\n## Rewritten\n\nThese links were changed so they resolve. \
             The originals are in the vault this was imported from, which was \
             not modified.\n",
        );
        for (note, items) in &rewrote {
            out.push_str(&format!("\n[[{note}]]\n\n"));
            for (from, to) in items {
                out.push_str(&format!("- `{from}` → `{to}`\n"));
            }
        }
    }

    out
}

#[cfg(test)]
#[path = "import/tests.rs"]
mod tests;
