//! `register extract` — a vault and its reader as one file (§12, ADR-008).
//!
//! The served app is a folder of markdown behind a binary. An extract is the
//! same reader with the folder's answers written inline: one HTML file that
//! opens from disk, carrying the tree, every note's bytes, the images and PDFs
//! the vault holds as `data:` URLs — and the UI itself, the bundle the binary
//! serves folded into one script and one sheet, with the OFL faces inlined.
//! Search, links, backlinks, tags, the outline and TODAY are all derived in the
//! browser already, so a page with the corpus in it needs no server to derive
//! them again.
//!
//! Nothing under `.register/` is read. The trash, the config and above all the
//! licensed face (§03, rule 7) stay where they are, because a file made to be
//! handed on must carry nothing that was not meant to travel — which is also
//! why the vault's absolute path is not in it.
//!
//! Read-only by construction, and the page says so. The client finds the
//! payload, answers every read from it, refuses every write, and shows the
//! stamp this was written at where the watcher's lamp would be. The file's own
//! policy says `connect-src 'none'`: it cannot ask anything of anyone, and the
//! browser enforces that before a line of it runs.
//!
//! No new crate (rule 6). Base64 is thirty lines; the template is filled in
//! one pass that never rescans what it inserted; the JSON is `serde_json`'s
//! with the three characters that could close a `<script>` written as the
//! escapes a browser reads back as themselves.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use clap::ValueEnum;
use serde::Serialize;

use crate::scaffold;
use crate::server::Assets;
use crate::vault::{self, Vault};

/// The element the payload is written into. `app/src/core/offline.ts` reads it
/// by this id; a test holds the two spellings together.
pub const PAYLOAD_ID: &str = "register-extract";

const TEMPLATE: &str = include_str!("extract/template.html");

/// Whether the vault's images and PDFs travel with the notes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum Media {
    /// Every file the vault holds, as a `data:` URL. The default, and the size.
    Inline,
    /// None. A reference to one is drawn as §02b Screen 8 draws a missing target.
    None,
}

/// Whether the bundled OFL faces travel, or the page reads in the system's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum Faces {
    /// Commit Mono, Departure Mono and Server Mono, inlined. About 220 kB.
    All,
    /// No `@font-face` at all: the stack falls through to `ui-monospace`.
    None,
}

/// The reader half of an extract: the UI, gathered before any vault is read.
///
/// Its own type so `render` can be handed a stand-in. The tests build one from
/// a few lines of text and prove the vault half without `pnpm build` — which
/// CI's server job never runs, and which is exactly why an assertion here must
/// not depend on it.
pub struct Reader {
    pub boot: String,
    pub css: String,
    pub js: String,
    /// `fonts/<family>/<file>.woff2` → bytes: the faces `base.css` names.
    pub fonts: BTreeMap<String, Vec<u8>>,
}

impl Reader {
    /// The embedded UI, or what to run to get one.
    pub fn embedded() -> Result<Self, String> {
        let missing = |what: &str| {
            format!("no {what} bundled; run `cd app && pnpm build` and rebuild the binary")
        };
        let text = |file: Option<rust_embed::EmbeddedFile>| {
            file.map(|f| String::from_utf8_lossy(&f.data).into_owned())
        };
        let fonts = Assets::iter()
            .filter(|path| path.starts_with("fonts/") && path.ends_with(".woff2"))
            .filter_map(|path| {
                Assets::get(&path).map(|file| (path.into_owned(), file.data.into_owned()))
            })
            .collect();
        Ok(Self {
            boot: text(Assets::get("boot.js")).ok_or_else(|| missing("boot script"))?,
            // The single-file build (`app/vite.extract.config.ts`), which
            // `pnpm build` writes beside the served one and the server never
            // serves.
            css: text(Assets::get("extract/extract.css"))
                .ok_or_else(|| missing("extract stylesheet"))?,
            js: text(Assets::get("extract/extract.js")).ok_or_else(|| missing("extract script"))?,
            fonts,
        })
    }
}

/// What the file carries, in the shape `app/src/core/offline.ts` reads.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    tree: vault::Tree,
    notes: BTreeMap<String, String>,
    files: BTreeMap<String, String>,
    stamp: String,
}

/// What an extract came to.
pub struct Written {
    pub out: PathBuf,
    pub notes: usize,
    pub files: usize,
    /// Vault paths left out, each with why — a file the vault refused to serve,
    /// a note it could not read. Said, not swallowed.
    pub skipped: Vec<String>,
    pub bytes: usize,
}

/// One rendered extract, before it is written anywhere.
pub struct Rendered {
    pub html: String,
    pub notes: usize,
    pub files: usize,
    pub skipped: Vec<String>,
}

/// Write `root` and its reader to `out`, or to a dated file beside the caller.
pub fn extract(
    root: &Path,
    out: Option<&Path>,
    media: Media,
    faces: Faces,
    now: SystemTime,
) -> Result<Written, String> {
    // The same refusal `new` makes: a folder holding no vault is not read, so a
    // mistyped path yields a message rather than an extract of somebody's
    // Documents folder.
    if !scaffold::holds_a_vault(root) {
        return Err(format!(
            "{} holds no vault; nothing to extract",
            root.display()
        ));
    }
    let vault = Vault::open(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let reader = Reader::embedded()?;

    let out = match out {
        Some(path) => path.to_path_buf(),
        None => PathBuf::from(default_name(&name_of(&vault), now)),
    };
    refuse_inside(&vault, &out)?;
    refuse_clobber(&out)?;

    let rendered = render(&vault, &reader, media, faces, now)?;
    // A plain write, and deliberately not `vault.rs`'s: the file is outside the
    // vault — refused inside it two lines up — and rule 5 governs what goes
    // into a vault, not what is written beside one.
    fs::write(&out, &rendered.html).map_err(|e| format!("{}: {e}", out.display()))?;

    Ok(Written {
        out,
        notes: rendered.notes,
        files: rendered.files,
        skipped: rendered.skipped,
        bytes: rendered.html.len(),
    })
}

/// The whole file, from a vault and a reader.
pub fn render(
    vault: &Vault,
    reader: &Reader,
    media: Media,
    faces: Faces,
    now: SystemTime,
) -> Result<Rendered, String> {
    let name = name_of(vault);
    let mut skipped = Vec::new();

    let mut tree = vault::Tree {
        // The folder's name, never its path: where a vault lives on the disk it
        // was cut from is nobody else's business, and this file is for handing on.
        vault: name.clone(),
        rev: 0,
        next_ref: vault.next_ref().map_err(|e| e.to_string())?,
        // Not a repository as far as this file is concerned. History is a §12
        // question of its own, and `null` is the measured absence the GIT field
        // already knows how to draw.
        git: None,
        notes: vault.list().map_err(|e| e.to_string())?,
    };

    let mut notes = BTreeMap::new();
    for entry in &tree.notes {
        match vault.read(&entry.path) {
            Ok((body, _)) => {
                notes.insert(entry.path.clone(), body);
            }
            Err(e) => skipped.push(format!("{}: {e}; left out", entry.path)),
        }
    }
    // A note with no body is a row the client would open and fail on, so the
    // tree carries only what the payload can answer for.
    tree.notes.retain(|entry| notes.contains_key(&entry.path));

    let mut files = BTreeMap::new();
    if media == Media::Inline {
        for rel in vault.files().map_err(|e| e.to_string())? {
            match vault.read_media(&rel) {
                Ok((bytes, format, _)) => {
                    files.insert(rel, data_url(format.media_type, &bytes));
                }
                Err(e) => skipped.push(format!("{rel}: {e}; left out")),
            }
        }
    }

    let payload = Payload {
        tree,
        notes,
        files,
        stamp: scaffold::iso_seconds(scaffold::unix_seconds(now)),
    };
    let json = serde_json::to_string(&payload).map_err(|e| format!("payload: {e}"))?;

    let html = fill(
        TEMPLATE,
        &[
            ("TITLE", &format!("REGISTER · {}", escape_html(&name))),
            ("BOOT", &reader.boot),
            ("CSS", &inline_fonts(&reader.css, &reader.fonts, faces)),
            ("ID", PAYLOAD_ID),
            ("PAYLOAD", &escape_json(&json)),
            ("JS", &reader.js.replace("</script", "<\\/script")),
        ],
    );

    Ok(Rendered {
        html,
        notes: payload.notes.len(),
        files: payload.files.len(),
        skipped,
    })
}

/// The vault's folder name, for the title and the status bar.
fn name_of(vault: &Vault) -> String {
    vault
        .root()
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "vault".to_owned())
}

/// `<name>-<date>.html`: what an extract is called when nobody names it.
pub fn default_name(name: &str, now: SystemTime) -> String {
    format!(
        "{name}-{}.html",
        scaffold::iso_date(scaffold::unix_seconds(now))
    )
}

/// An extract is written beside a vault, never into it.
///
/// Into it would put a file the tree never shows under the watcher, the
/// importer's walk and `git add -A` — and the next extract would then carry
/// the last one. The parent is canonicalised so a symlinked temp directory
/// and a `../` in the argument both answer honestly.
fn refuse_inside(vault: &Vault, out: &Path) -> Result<(), String> {
    let parent = match out.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let parent = parent
        .canonicalize()
        .map_err(|e| format!("{}: {e}", parent.display()))?;
    if parent.starts_with(vault.root()) {
        return Err(format!(
            "{} is inside the vault; an extract is written beside a vault, never into it",
            out.display()
        ));
    }
    Ok(())
}

/// Replace an extract, and nothing else.
///
/// The dated default name makes a second run of the day land on the first,
/// which is what anyone running it twice means. A file that is not an extract
/// is somebody's, and `-o` naming it by mistake must not cost them it.
fn refuse_clobber(out: &Path) -> Result<(), String> {
    let Ok(existing) = fs::read_to_string(out) else {
        return Ok(());
    };
    if existing.contains(&format!("id=\"{PAYLOAD_ID}\"")) {
        return Ok(());
    }
    Err(format!(
        "{} exists and is not an extract; name another file with --out",
        out.display()
    ))
}

// ------------------------------------------------------------------ the sheet

/// The stylesheet with its faces carried inline, or with none.
///
/// The built sheet points at `/fonts/…`, which a served page fetches and a
/// page opened from disk cannot — the policy says `font-src data:` and nothing
/// else. So each `url(/fonts/…)` becomes the bytes it named, or, with
/// `--faces none`, the whole `@font-face` goes and the stack falls through to
/// the system's monospace. Never a licensed face: `fonts` holds only what the
/// binary embeds, and rule 7 keeps that OFL.
fn inline_fonts(css: &str, fonts: &BTreeMap<String, Vec<u8>>, faces: Faces) -> String {
    match faces {
        Faces::None => strip_font_faces(css),
        Faces::All => {
            let mut out = String::with_capacity(css.len());
            let mut rest = css;
            while let Some(start) = rest.find("url(/fonts/") {
                let Some(len) = rest[start..].find(')') else {
                    break;
                };
                // `url(` is four bytes; `/fonts/…` follows, and the embedded
                // path has no leading slash.
                let path = &rest[start + 5..start + len];
                out.push_str(&rest[..start]);
                match fonts.get(path) {
                    Some(bytes) => {
                        out.push_str("url(");
                        out.push_str(&data_url("font/woff2", bytes));
                        out.push(')');
                    }
                    // A face the binary does not carry is left as it was — it
                    // fails to load and the stack moves on, which is what it
                    // would have done on a served page missing the file.
                    None => out.push_str(&rest[start..start + len + 1]),
                }
                rest = &rest[start + len + 1..];
            }
            out.push_str(rest);
            out
        }
    }
}

/// Every `@font-face{…}` block removed. The blocks nest nothing.
fn strip_font_faces(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = rest.find("@font-face") {
        let Some(end) = rest[start..].find('}') else {
            break;
        };
        out.push_str(&rest[..start]);
        rest = &rest[start + end + 1..];
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------- the escapes

/// JSON that can sit inside a `<script>`.
///
/// `serde_json` escapes what JSON requires and no more, and JSON does not
/// require `<` — so a note holding `</script>` would end the block and the
/// rest of the note would run as the page. The three characters that can open
/// or close a tag are written as `\u00XX`, which JSON reads back as the
/// characters themselves. Line and paragraph separators go the same way: they
/// are legal in JSON strings and were, for years, illegal in JavaScript ones.
fn escape_json(json: &str) -> String {
    let mut out = String::with_capacity(json.len());
    for c in json.chars() {
        match c {
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            other => out.push(other),
        }
    }
    out
}

/// Text that can sit inside an element or an attribute.
fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// Fill `{{KEY}}` slots in one pass, left to right.
///
/// One pass is the point. A chain of `replace` calls rescans what the earlier
/// ones inserted, so a note containing the literal `{{JS}}` would have the
/// bundle written into its body. Here the template is the only thing ever
/// scanned; a value is copied and never read.
fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out =
        String::with_capacity(template.len() + values.iter().map(|(_, v)| v.len()).sum::<usize>());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let Some(len) = rest[start..].find("}}") else {
            break;
        };
        let key = &rest[start + 2..start + len];
        out.push_str(&rest[..start]);
        match values.iter().find(|(name, _)| *name == key) {
            Some((_, value)) => out.push_str(value),
            None => out.push_str(&rest[start..start + len + 2]),
        }
        rest = &rest[start + len + 2..];
    }
    out.push_str(rest);
    out
}

// ------------------------------------------------------------------- the bytes

fn data_url(media_type: &str, bytes: &[u8]) -> String {
    format!("data:{media_type};base64,{}", base64(bytes))
}

/// RFC 4648 base64, padded. Hand-rolled for the reason `ulid` and `civil` are:
/// it is thirty lines, and a crate for it is a dependency under rule 6.
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).copied().map_or(0, u32::from);
        let b2 = chunk.get(2).copied().map_or(0, u32::from);
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18 & 63) as usize] as char);
        out.push(TABLE[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// `3.1 MB`, `412 kB`, `980 B` — the size the report line says.
pub fn human(bytes: usize) -> String {
    if bytes >= 1_000_000 {
        format!("{:.1} MB", bytes as f64 / 1_000_000.0)
    } else if bytes >= 1_000 {
        format!("{} kB", bytes / 1_000)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
pub(crate) mod tests;
