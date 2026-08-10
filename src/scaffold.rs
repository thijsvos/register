//! Creating conforming vault content (§08 P8).
//!
//! Everything here writes files a fresh agent has to be able to read without
//! being told anything: §04's layout, §04's frontmatter, and §04's agent
//! contract reproduced byte for byte. If this module and §04 ever disagree, §04
//! is right and this is a bug.

use std::collections::hash_map::RandomState;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::vault::{APP_DIR, Vault};

/// §04's agent contract, verbatim. Written into every vault by `register init`.
///
/// Normative — the spec calls this template "normative" and P8's prompt repeats
/// it — so it is a single literal rather than anything assembled, and the tests
/// compare it against the spec's own copy. The trailing newline is ours: the
/// spec shows the text, and a text file ends with one.
pub const VAULT_CLAUDE_MD: &str = r#"# This folder is a REGISTER vault — agent contract

Plain markdown, rendered live by the REGISTER app. There is no
database; these files are the entire state. Edit them freely with
normal file tools — the UI hot-reloads within 100 ms.

## Layout
notes/NNN-slug.md     # NNN = zero-padded ref, immutable
daily/YYYY-MM-DD.md   # daily logs
000-inbox.md          # capture queue — append, don't reorganize
templates/            # note templates
.register/            # app config — do not read or write

## Note format (required frontmatter)
---
id: ULID              # never change an existing id
ref: NNN              # never change an existing ref
title: Plain title
created: YYYY-MM-DD
modified: ISO-8601    # update when you edit
tags: [lowercase, words]
---

## Syntax that the app understands
[[Title]] or [[NNN]]  wikilink        - [ ] / - [x]  task
Everything else is ordinary markdown.

## Creating a note
1. ref  = the `nextRef` from GET /api/tree, or if you are working
   the files directly: one above the highest NNN ever used, counting
   .register/trash/ — never reuse a deleted ref
2. id   = fresh ULID
3. file = notes/NNN-kebab-slug.md with full frontmatter

## Creating a daily log
daily/YYYY-MM-DD.md, and it takes no ref — a date is not one.
Otherwise the same header: fresh id, title AND created = the date.
Never copy templates/daily.md as-is. Its fields all read TEMPLATE
and stay that way; the app shows what the file says, not what you
meant. Fill them in, or let the app cut it for you.

## Rules
- Never touch .register/ .
- *.conflict-*.md are unresolved conflicts: merge into the
  original, then delete the conflict file.
- If this vault is a git repo, commit in small units with
  messages like "note: 014 add crdt reading notes".
"#;

/// The stencil `GO · DAILY LOG` cuts today's note from (§08 P7).
///
/// The placeholders are literal: `dailyFrom` in the client replaces `id`,
/// `title`, `created` and `modified`, and keeps everything else — so what is
/// here is the shape of a day, not its content. No `- [ ]` in it on purpose; an
/// empty task would land in every daily log and then in TODAY.
const DAILY_TEMPLATE: &str = "---\n\
id: TEMPLATE\n\
title: TEMPLATE\n\
created: TEMPLATE\n\
modified: TEMPLATE\n\
tags: [daily]\n\
---\n\
## Log\n\
\n\
## Tasks\n";

/// §04: "000-inbox.md — capture queue — append, don't reorganize".
const INBOX_BODY: &str = "Capture queue. Append, don't reorganize.\n";

/// Nothing reads this yet. §02b Screen 6 is the only chrome that writes config,
/// and it decides the keys — inventing a schema here would be guessing at a
/// screen that has not been built.
const CONFIG_JSON: &str = "{}\n";

/// `--git`: the two directories that must never be committed (§08 P8).
///
/// BYOF font bytes are licensed to the user, not to the repository (§03), and
/// trash is deleted notes kept only so a ref is never reissued.
const GITIGNORE: &str = ".register/fonts/\n.register/trash/\n";

/// What `init` did, so the caller can say it rather than guess.
#[derive(Debug, Default)]
pub struct Report {
    pub created: Vec<String>,
    /// Already there. `init` never overwrites: re-running it on a real vault
    /// must be safe, or nobody can use it to add the pieces they are missing.
    pub kept: Vec<String>,
    /// Anything that did not go to plan but did not make the vault unusable —
    /// said out loud rather than swallowed, because the alternative is a vault
    /// that is subtly not what was asked for and never mentions it.
    pub notes: Vec<String>,
}

/// Scaffold a vault at `root`, creating only what is absent.
pub fn init(root: &Path, git: bool) -> io::Result<Report> {
    let mut report = Report::default();

    fs::create_dir_all(root)?;
    for dir in [
        "notes",
        "daily",
        "templates",
        APP_DIR,
        &format!("{APP_DIR}/fonts"),
        &format!("{APP_DIR}/trash"),
    ] {
        fs::create_dir_all(root.join(dir))?;
    }

    let now = SystemTime::now();
    let inbox = note("000", "Inbox", &["capture"], INBOX_BODY, now, None);

    for (rel, body) in [
        ("CLAUDE.md", VAULT_CLAUDE_MD.to_owned()),
        ("000-inbox.md", inbox),
        ("templates/daily.md", DAILY_TEMPLATE.to_owned()),
        (&format!("{APP_DIR}/config.json"), CONFIG_JSON.to_owned()),
    ] {
        write_new(root, rel, &body, &mut report)?;
    }

    if git {
        write_new(root, ".gitignore", GITIGNORE, &mut report)?;
        // Only a repository *we* just created gets a commit. Someone who ran
        // `git init` themselves and then pointed us at the folder has staged
        // work and intentions we know nothing about, and `git add -A` would
        // sweep all of it into a commit called "vault: initial".
        if init_git(root)?
            && let Some(note) = commit_the_scaffold(root)
        {
            report.notes.push(note);
        }
    }

    Ok(report)
}

/// Write `rel` unless it is already there. Recorded either way.
fn write_new(root: &Path, rel: &str, body: &str, report: &mut Report) -> io::Result<()> {
    let path = root.join(rel);
    if path.exists() {
        report.kept.push(rel.to_owned());
        return Ok(());
    }
    fs::write(&path, body)?;
    report.created.push(rel.to_owned());
    Ok(())
}

/// A `git` child for the scaffold, disarmed the same way the status path is.
///
/// `init` and the baseline commit run against a directory the user pointed at,
/// which may already carry someone else's `.git`. See [`crate::git::hardened`]:
/// a repository's config is code, and `commit` in particular runs hooks that
/// `--no-verify` does not cover.
fn git_command(root: &Path) -> Command {
    crate::git::hardened(root)
}

/// Make the vault a repository. `Ok(false)` when it already was one.
fn init_git(root: &Path) -> io::Result<bool> {
    if root.join(".git").exists() {
        return Ok(false);
    }
    let status = git_command(root)
        .arg("init")
        .arg("--quiet")
        .status()
        .map_err(|error| {
            io::Error::other(format!(
                "the vault is complete, but `git init` could not run: {error}"
            ))
        })?;

    if !status.success() {
        return Err(io::Error::other(
            "the vault is complete, but `git init` failed",
        ));
    }
    Ok(true)
}

/// Commit the freshly written scaffold, so the repository has a baseline.
///
/// Without it `--git` leaves a repository with no commits at all: the status bar
/// reads DIRTY on a vault nobody has touched, `git log` has nothing to say, and
/// the first checkpoint silently becomes the initial import. Returns a note when
/// it could not commit, which is not a failure — the vault is complete either
/// way, and the usual cause is a machine with no `user.email` configured.
fn commit_the_scaffold(root: &Path) -> Option<String> {
    // Only ever the repository we just made. A vault that already had history
    // is not ours to write to.
    let head = git_command(root)
        .args(["rev-parse", "--verify", "HEAD"])
        .output()
        .ok()?;
    if head.status.success() {
        return None;
    }

    let staged = git_command(root).args(["add", "-A"]).status().ok()?;
    if !staged.success() {
        return Some("git add failed, so the vault is uncommitted".to_owned());
    }

    // `--no-verify`: someone's global hooks template should not get a vote on
    // whether a new vault has a first commit.
    let out = git_command(root)
        .args(["commit", "--no-verify", "-m", "vault: initial"])
        .output()
        .ok()?;
    if out.status.success() {
        return None;
    }

    let why = String::from_utf8_lossy(&out.stderr);
    let why = why
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    Some(format!(
        "the vault is complete but uncommitted ({}). `git commit` in it when you have set an identity.",
        why.trim()
    ))
}

/// `register new "title"`: a conforming note, and the path it was written to.
///
/// The ref comes from the vault rather than from a count of what is visible,
/// because §04 requires that a ref is issued at most once and only `next_ref`
/// can see `.register/trash/`.
pub fn create(vault: &Vault, title: &str) -> io::Result<String> {
    let reference = vault
        .next_ref()
        .map_err(|error| io::Error::other(format!("allocate a ref: {error}")))?;
    let rel = format!("notes/{reference}-{}.md", slug(title));

    if vault.root().join(&rel).exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{rel} already exists"),
        ));
    }

    let body = note(&reference, title, &[], "", SystemTime::now(), None);
    // Through the vault, never through `fs`: hard rule 5 routes every write in
    // the product through one atomic tmp+rename path.
    vault
        .write(&rel, &body, None)
        .map_err(|error| io::Error::other(format!("write {rel}: {error}")))?;

    Ok(rel)
}

/// A note with every field §04 requires.
fn note(
    reference: &str,
    title: &str,
    tags: &[&str],
    body: &str,
    now: SystemTime,
    id: Option<&str>,
) -> String {
    let stamp = unix_seconds(now);
    format!(
        "---\nid: {}\nref: {reference}\ntitle: {title}\ncreated: {}\nmodified: {}\ntags: [{}]\n---\n{body}",
        id.map_or_else(|| ulid(now), str::to_owned),
        iso_date(stamp),
        iso_seconds(stamp),
        tags.join(", "),
    )
}

// ------------------------------------------------------------------- slugging

/// `Terminal aesthetics!` → `terminal-aesthetics`.
///
/// Mirrors `app/src/core/refs.ts::slug`, because the same title typed into the
/// UI and passed to the CLI has to name the same file.
pub fn slug(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut pending_dash = false;

    for raw in title.chars() {
        for ch in raw.to_lowercase() {
            let ch = fold(ch);
            if ch.is_ascii_alphanumeric() {
                if pending_dash && !out.is_empty() {
                    out.push('-');
                }
                pending_dash = false;
                out.push(ch);
            } else {
                pending_dash = true;
            }
        }
    }

    if out.is_empty() {
        "untitled".to_owned()
    } else {
        out
    }
}

/// Strip the accent from a Latin letter, so `Café` slugs as `cafe` and not as
/// `caf`, matching the client's `normalize('NFKD')` for the range that actually
/// turns up in titles. Full normalisation would need a Unicode crate, and rule 6
/// prices that above the value of covering the rest of the range.
fn fold(ch: char) -> char {
    match ch {
        'à'..='å' => 'a',
        'è'..='ë' => 'e',
        'ì'..='ï' => 'i',
        'ò'..='ö' => 'o',
        'ù'..='ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        'ý' | 'ÿ' => 'y',
        other => other,
    }
}

// ---------------------------------------------------------------------- dates

fn unix_seconds(now: SystemTime) -> i64 {
    now.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `2026-08-05` from a Unix timestamp, by the civil-from-days algorithm — the
/// standard shift-the-epoch-to-March one, so leap years need no special case.
fn iso_date(seconds: i64) -> String {
    let (year, month, day) = civil(seconds.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}")
}

/// `2026-08-05T09:16:40Z` — §04's `modified`.
fn iso_seconds(seconds: i64) -> String {
    let (year, month, day) = civil(seconds.div_euclid(86_400));
    let rest = seconds.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        (rest / 60) % 60,
        rest % 60,
    )
}

/// Days since the Unix epoch → (year, month, day), Howard Hinnant's civil_from_days.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

// ----------------------------------------------------------------------- ulid

/// Crockford base32 — no I, L, O or U, so a ULID cannot be misread aloud.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS: u32 = 10;
const RANDOM_CHARS: u32 = 16;

/// A ULID: 48 bits of millisecond timestamp then 80 bits of randomness, 26
/// Crockford-base32 characters, lexicographically sortable.
///
/// Mirrors `app/src/lib/ulid.ts`. §04 requires one per note and requires that it
/// never change once written, so this is only ever called when creating one.
pub fn ulid(now: SystemTime) -> String {
    let ms = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let mut out = String::with_capacity((TIME_CHARS + RANDOM_CHARS) as usize);
    for i in (0..TIME_CHARS).rev() {
        out.push(ALPHABET[((ms >> (5 * i)) & 31) as usize] as char);
    }
    let bits = entropy();
    for i in (0..RANDOM_CHARS).rev() {
        out.push(ALPHABET[((bits >> (5 * i)) & 31) as usize] as char);
    }
    out
}

/// 128 bits of per-call variation, of which the ULID uses 80.
///
/// `std` ships no random number generator. `RandomState` is the one OS-seeded
/// source it does expose: its seed is drawn once per thread from the platform's
/// CSPRNG and a counter advances per instance, so two hashers built inside the
/// same millisecond produce unrelated SipHash output. Mixed with the clock and a
/// process-lifetime counter, that is ample for a value whose only job is to keep
/// two notes created in the same millisecond apart.
///
/// Deliberately not cryptographic, and nothing here needs it to be — a ULID is a
/// note's name, not a secret. Rule 6 prices a `rand` dependency above that.
fn entropy() -> u128 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nth = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let mix = |salt: u64| {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(nth);
        hasher.write_u64(salt);
        hasher.write_u128(nanos);
        hasher.finish()
    };

    (u128::from(mix(0)) << 64) | u128::from(mix(1))
}

/// The vault a bare `register new` works on: the current directory.
pub fn here() -> io::Result<PathBuf> {
    std::env::current_dir()
}

#[cfg(test)]
mod tests;
