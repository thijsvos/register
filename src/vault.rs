//! Vault I/O — the only path through which REGISTER touches the filesystem.
//!
//! Hard rule 5: every write goes through here, atomically (tmp + rename) and
//! guarded by an etag. Nothing else in the codebase opens a file for writing.

use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File, Metadata};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// App-owned directory. §04: "app-owned; agents keep out."
pub const APP_DIR: &str = ".register";
const TRASH_DIR: &str = "trash";
const FONTS_DIR: &str = "fonts";
const CONFIG_FILE: &str = "config.json";
/// One licensed face per vault, under a fixed name — §03 registers it as the
/// single family "TX-02", so a second would have nowhere to go.
const FONT_STEM: &str = "licensed";

/// A font container this app will accept, by its magic number.
pub struct FontFormat {
    pub extension: &'static str,
    pub media_type: &'static str,
    magic: &'static [u8],
}

/// §03 offers ".woff2 / .ttf / .otf". woff is here too because it costs one row
/// and a user who owns the face may well have been given that container.
const FONT_FORMATS: &[FontFormat] = &[
    FontFormat {
        extension: "woff2",
        media_type: "font/woff2",
        magic: b"wOF2",
    },
    FontFormat {
        extension: "woff",
        media_type: "font/woff",
        magic: b"wOFF",
    },
    FontFormat {
        extension: "otf",
        media_type: "font/otf",
        magic: b"OTTO",
    },
    FontFormat {
        extension: "ttf",
        media_type: "font/ttf",
        magic: &[0x00, 0x01, 0x00, 0x00],
    },
    // Older TrueType, still handed out by some foundries.
    FontFormat {
        extension: "ttf",
        media_type: "font/ttf",
        magic: b"true",
    },
];

/// Which font container `bytes` is, by its first four bytes — never by the name
/// the browser reported, which is a user-supplied string.
pub fn font_format(bytes: &[u8]) -> Option<&'static FontFormat> {
    FONT_FORMATS
        .iter()
        .find(|format| bytes.starts_with(format.magic))
}
/// §04's dated-log directory. Its filenames are dates, not refs.
const DAILY_DIR: &str = "daily/";
/// Marks an unresolved conflict copy (§04).
const CONFLICT_MARK: &str = ".conflict-";
const NOTE_EXT: &str = "md";
/// §04's examples are three digits (`003-…`).
const MIN_REF_WIDTH: usize = 3;
/// How many same-millisecond, same-basename deletions to disambiguate before
/// giving up. Reaching this means something pathological is happening.
const MAX_TRASH_COLLISIONS: u32 = 1024;

#[derive(Debug)]
pub enum Error {
    /// The path escaped the vault, named a dot-segment, or was otherwise unusable.
    InvalidPath,
    NotFound,
    /// `If-Match` did not match what is on disk. Carries the current etag so the
    /// client can write its `*.conflict-<ts>.md` copy without a second request.
    Conflict {
        current: String,
    },
    /// The bytes offered as a licensed face are not a font container this app
    /// recognises (§03: woff2 / woff / otf / ttf).
    UnsupportedFont,
    Io(io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => write!(f, "path is outside the vault"),
            Self::NotFound => write!(f, "no such note"),
            Self::Conflict { current } => write!(f, "etag is stale; current is {current}"),
            Self::UnsupportedFont => write!(f, "not a woff2, woff, otf or ttf font"),
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        if e.kind() == io::ErrorKind::NotFound {
            Self::NotFound
        } else {
            Self::Io(e)
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// The body of `GET /api/tree` (§04).
///
/// An envelope rather than a bare array, because two things the UI needs are
/// properties of the vault and not of any one note: where the vault lives, and
/// which ref a new note should take.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    /// Absolute path of the vault, for the status bar (§02b Screen 1).
    pub vault: String,
    /// The ref a new note must take.
    pub next_ref: String,
    /// The vault's git state, or `null` when it is not a repository of its own
    /// (§08 P12). §02b Screen 1 has a GIT field and until now nothing could
    /// fill it.
    pub git: Option<crate::git::Status>,
    pub notes: Vec<Entry>,
}

/// One row of `GET /api/tree` (§04). Everything except `path` is derived, and
/// every derived field is optional: the tree must survive a note an agent is
/// halfway through writing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub path: String,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub title: Option<String>,
    pub tags: Vec<String>,
    /// Filesystem mtime in epoch milliseconds. Distinct from the frontmatter
    /// `modified` field, which is whatever the last writer claimed.
    pub mtime: i64,
    pub size: u64,
    pub etag: String,
}

/// The §04 frontmatter fields the tree needs.
#[derive(Debug, Default, Deserialize)]
struct Frontmatter {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
}

pub struct Vault {
    root: PathBuf,
    /// Serialises check-then-act sequences. Hard rule 5 routes every write in
    /// the product through this type, so one in-process lock is enough to make
    /// "compare the etag, then rename" atomic. Two `register` processes over one
    /// vault would still race; that is a documented limit, not a covered case.
    writes: Mutex<()>,
}

impl Vault {
    /// Open an existing directory as a vault.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        if !root.is_dir() {
            return Err(Error::NotFound);
        }
        Ok(Self {
            root: root.canonicalize()?,
            writes: Mutex::new(()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// A poisoned lock only means an earlier writer panicked partway through.
    /// The vault is still consistent, because a write is either a completed
    /// rename or nothing, so the guard is recovered rather than propagated.
    fn lock(&self) -> MutexGuard<'_, ()> {
        self.writes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reject a resolved path that leaves the vault through a symlink.
    ///
    /// `resolve` is purely lexical — it can only reason about the text of a
    /// request. That is not a containment guarantee: every one of `fs::metadata`,
    /// `File::create` and `fs::rename` follows symlinks in the parent chain, so a
    /// single `ln -s ~ <vault>/home` inside an ordinary user-owned directory
    /// would turn `/api/note/home/.ssh/authorized_keys` into an arbitrary write.
    /// Symlinked subtrees are legitimate user practice (a synced folder, a
    /// shortcut into a project), so this refuses rather than assumes.
    ///
    /// Checked component by component so a symlink anywhere in the chain is
    /// caught, including the final one — a note that is itself a link to
    /// `/etc/hosts` must not be readable either.
    fn verify_contained(&self, path: &Path) -> Result<()> {
        let rel = path
            .strip_prefix(&self.root)
            .map_err(|_| Error::InvalidPath)?;

        let mut prefix = self.root.clone();
        for component in rel.components() {
            let Component::Normal(segment) = component else {
                return Err(Error::InvalidPath);
            };
            prefix.push(segment);
            match fs::symlink_metadata(&prefix) {
                Ok(meta) if meta.file_type().is_symlink() => return Err(Error::InvalidPath),
                Ok(_) => {}
                // Nothing beyond here exists yet, so nothing beyond here can be
                // a link. `write` re-checks after it creates the parents.
                Err(e) if e.kind() == io::ErrorKind::NotFound => break,
                Err(e) => return Err(Error::Io(e)),
            }
        }
        Ok(())
    }

    /// Confirm a directory we just created really sits inside the vault.
    fn verify_parent(&self, parent: &Path) -> Result<()> {
        let canonical = parent.canonicalize()?;
        if canonical.starts_with(&self.root) {
            Ok(())
        } else {
            Err(Error::InvalidPath)
        }
    }

    /// Map a vault-relative request path to an absolute path inside the vault.
    ///
    /// This is the security boundary of the whole server. It rejects `..`,
    /// absolute paths, Windows separators and any dot-prefixed segment — which
    /// also makes `.register/` unreachable through the API, as §04 requires.
    fn resolve(&self, rel: &str) -> Result<PathBuf> {
        // An absolute path is refused rather than quietly reinterpreted as a
        // vault-relative one: a client that sends `/etc/passwd` is confused, and
        // silently creating `<vault>/etc/passwd` would hide the bug.
        if rel.starts_with('/') || rel.contains('\\') || rel.contains('\0') || rel.is_empty() {
            return Err(Error::InvalidPath);
        }

        let mut out = self.root.clone();
        let mut depth = 0usize;
        for component in Path::new(rel).components() {
            let Component::Normal(segment) = component else {
                return Err(Error::InvalidPath);
            };
            let segment = segment.to_str().ok_or(Error::InvalidPath)?;
            if segment.starts_with('.') {
                return Err(Error::InvalidPath);
            }
            out.push(segment);
            depth += 1;
        }
        if depth == 0 {
            return Err(Error::InvalidPath);
        }
        // One definition of "a note", shared with `list` and `is_visible`.
        // Without this the write path is looser than the read path: PUT would
        // happily create files the tree can never show and the watcher never
        // reports, which is a silent way to lose data inside your own vault.
        if out.extension().and_then(|e| e.to_str()) != Some(NOTE_EXT) {
            return Err(Error::InvalidPath);
        }
        Ok(out)
    }

    /// The vault root can be renamed or deleted while the server runs. Without
    /// this, `create_dir_all` cheerfully resurrects the old tree and writes into
    /// a ghost vault nobody is watching, answering 200 the whole time.
    fn require_root(&self) -> Result<()> {
        if self.root.is_dir() {
            Ok(())
        } else {
            Err(Error::Io(io::Error::new(
                io::ErrorKind::NotFound,
                "vault root is gone",
            )))
        }
    }

    /// Vault-relative path with `/` separators, whatever the platform (§11).
    fn relative(&self, path: &Path) -> Result<String> {
        let rel = path
            .strip_prefix(&self.root)
            .map_err(|_| Error::InvalidPath)?;
        let mut out = String::new();
        for component in rel.components() {
            let Component::Normal(segment) = component else {
                return Err(Error::InvalidPath);
            };
            if !out.is_empty() {
                out.push('/');
            }
            out.push_str(segment.to_str().ok_or(Error::InvalidPath)?);
        }
        Ok(out)
    }

    /// The whole `GET /api/tree` body.
    pub fn tree(&self) -> Result<Tree> {
        Ok(Tree {
            vault: self.root.display().to_string(),
            next_ref: self.next_ref()?,
            // Cheap when the vault is not a repository — one `rev-parse` — and
            // the tree is already a blocking walk of the whole vault, so a
            // `git status` on top of it is not what makes this call expensive.
            git: crate::git::status(&self.root),
            notes: self.list()?,
        })
    }

    /// The ref a new note must take: one above the highest ever allocated.
    ///
    /// Trashed notes count. §04 originally said "highest *existing* + 1", which
    /// meant deleting the highest note handed its ref straight back out and a
    /// `[[NNN]]` wikilink silently re-pointed at a different note. Trash keeps
    /// each note at its original path precisely so the ref it used is still
    /// recoverable here.
    pub fn next_ref(&self) -> Result<String> {
        let mut highest: i64 = -1;
        let mut width = MIN_REF_WIDTH;

        let mut consider = |rel: &str| {
            let Some(found) = ref_from_path(rel) else {
                return;
            };
            let Ok(value) = found.parse::<i64>() else {
                return;
            };
            highest = highest.max(value);
            width = width.max(found.len());
        };

        for rel in self.paths()? {
            consider(&rel);
        }
        for rel in self.trashed_paths() {
            consider(&rel);
        }

        Ok(format!("{:0width$}", highest + 1, width = width))
    }

    /// Vault-relative paths of trashed notes, as they were before deletion.
    fn trashed_paths(&self) -> Vec<String> {
        let root = self.root.join(APP_DIR).join(TRASH_DIR);
        let mut out = Vec::new();
        let Ok(buckets) = fs::read_dir(&root) else {
            return out;
        };
        for bucket in buckets.flatten() {
            let base = bucket.path();
            if base.is_dir() {
                collect_notes(&base, &base, &mut out);
            }
        }
        out
    }

    /// Every note in the vault, sorted by path.
    pub fn list(&self) -> Result<Vec<Entry>> {
        let mut out = Vec::new();
        self.walk(&self.root.clone(), &mut out)?;
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    fn walk(&self, dir: &Path, out: &mut Vec<Entry>) -> Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            // Skips .register/ and every editor swap file in one rule.
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };

            if meta.is_dir() {
                self.walk(&path, out)?;
                continue;
            }
            if !meta.is_file() || path.extension().and_then(|e| e.to_str()) != Some(NOTE_EXT) {
                continue;
            }
            // A note we cannot read is skipped, not fatal: one unreadable file
            // must not take down the whole tree.
            let Ok(body) = fs::read_to_string(&path) else {
                continue;
            };
            let Ok(rel) = self.relative(&path) else {
                continue;
            };
            out.push(entry_for(rel, &body, &meta));
        }
        Ok(())
    }

    /// Raw markdown plus its etag.
    pub fn read(&self, rel: &str) -> Result<(String, String)> {
        let path = self.resolve(rel)?;
        self.verify_contained(&path)?;
        let meta = fs::metadata(&path)?;
        if !meta.is_file() {
            return Err(Error::NotFound);
        }
        // A note that is not UTF-8 is not a note. `list` already skips it, so
        // reporting it as absent keeps the tree and the reader agreeing rather
        // than answering 500 for a file the tree never offered.
        let body = fs::read_to_string(&path).map_err(|e| match e.kind() {
            io::ErrorKind::InvalidData => Error::NotFound,
            _ => Error::from(e),
        })?;
        Ok((body, etag_of(&meta)))
    }

    /// Every note path, without reading or parsing any bodies. The watcher uses
    /// this to resync; `list` would read and YAML-parse the whole vault.
    pub fn paths(&self) -> Result<HashSet<String>> {
        let mut out = HashSet::new();
        self.walk_paths(&self.root.clone(), &mut out)?;
        Ok(out)
    }

    fn walk_paths(&self, dir: &Path, out: &mut HashSet<String>) -> Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                self.walk_paths(&path, out)?;
            } else if meta.is_file()
                && path.extension().and_then(|e| e.to_str()) == Some(NOTE_EXT)
                && let Ok(rel) = self.relative(&path)
            {
                out.insert(rel);
            }
        }
        Ok(())
    }

    /// Atomic write, guarded by `If-Match`. Returns the new etag.
    ///
    /// `if_match` of `None` writes unconditionally and creates a missing path,
    /// per §04. Supplying it on a path that has since been deleted is a
    /// conflict, not a create: the file changed under the client either way.
    pub fn write(&self, rel: &str, body: &str, if_match: Option<&str>) -> Result<String> {
        let path = self.resolve(rel)?;
        self.verify_contained(&path)?;
        self.require_root()?;

        // Held through the rename. Without it the etag check and the write are
        // separated by an fsync — a window wide enough that two clients holding
        // the same etag both pass, both rename, and one body is silently lost
        // while both callers are told 200. The 409 would never fire.
        let _writing = self.lock();

        let current = match fs::metadata(&path) {
            Ok(meta) if meta.is_file() => Some(etag_of(&meta)),
            Ok(_) => return Err(Error::InvalidPath),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(Error::Io(e)),
        };

        if let Some(expected) = if_match {
            let actual = current.unwrap_or_default();
            if actual != expected {
                return Err(Error::Conflict { current: actual });
            }
        }

        let parent = path.parent().ok_or(Error::InvalidPath)?;
        fs::create_dir_all(parent)?;
        // create_dir_all will happily build directories on the far side of a
        // symlink, so containment is re-checked once the parents exist.
        self.verify_parent(parent)?;

        write_atomically(&path, body.as_bytes())?;

        Ok(etag_of(&fs::metadata(&path)?))
    }

    // ------------------------------------------------------- app-owned files
    //
    // `.register/` is invisible to the note API by design — `walk` skips every
    // dot-prefixed name — so config and the BYOF face need their own way in.
    // Both are single fixed paths: nothing a caller sends chooses a filename,
    // so there is no traversal surface here at all.

    fn app_file(&self, name: &str) -> PathBuf {
        self.root.join(APP_DIR).join(name)
    }

    /// `.register/config.json` — §04's "theme, fonts, flags". `{}` when absent,
    /// because a vault without a config has made no choices, not an error.
    pub fn read_config(&self) -> Result<String> {
        match fs::read_to_string(self.app_file(CONFIG_FILE)) {
            Ok(text) => Ok(text),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok("{}".to_owned()),
            Err(e) => Err(Error::Io(e)),
        }
    }

    pub fn write_config(&self, body: &str) -> Result<()> {
        let _writing = self.lock();
        self.require_root()?;

        let path = self.app_file(CONFIG_FILE);
        // A vault made by hand rather than by `register init` has no
        // `.register/` at all, and the first setting anyone changes is where
        // that shows up.
        fs::create_dir_all(path.parent().ok_or(Error::InvalidPath)?)?;
        write_atomically(&path, body.as_bytes())
    }

    /// The stored BYOF face and its media type, if the user has loaded one.
    pub fn font(&self) -> Option<(PathBuf, &'static str)> {
        for format in FONT_FORMATS {
            let path = self.app_file(&format!("{FONTS_DIR}/{FONT_STEM}.{}", format.extension));
            if path.is_file() {
                return Some((path, format.media_type));
            }
        }
        None
    }

    /// Store `bytes` as the vault's licensed face (§03 BYOF).
    ///
    /// Sniffed before it is written, and refused if it is not a font. The bytes
    /// are handed straight to `FontFace` in a browser, and a file that is not a
    /// font produces a silently unstyled app rather than an error anyone can
    /// act on — better to say so at the moment of loading.
    pub fn write_font(&self, bytes: &[u8]) -> Result<()> {
        let format = font_format(bytes).ok_or(Error::UnsupportedFont)?;

        let _writing = self.lock();
        self.require_root()?;
        // One face at a time: loading a second must not leave the first behind
        // for `font()` to find by extension order.
        self.remove_font_locked()?;

        let path = self.app_file(&format!("{FONTS_DIR}/{FONT_STEM}.{}", format.extension));
        fs::create_dir_all(path.parent().ok_or(Error::InvalidPath)?)?;
        write_atomically(&path, bytes)
    }

    /// §08 P9: "remove wipes it".
    pub fn remove_font(&self) -> Result<()> {
        let _writing = self.lock();
        self.remove_font_locked()
    }

    fn remove_font_locked(&self) -> Result<()> {
        for format in FONT_FORMATS {
            let path = self.app_file(&format!("{FONTS_DIR}/{FONT_STEM}.{}", format.extension));
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(Error::Io(e)),
            }
        }
        Ok(())
    }

    /// Move a note to `.register/trash/`. §04: never hard-delete.
    pub fn trash(&self, rel: &str) -> Result<()> {
        let path = self.resolve(rel)?;
        self.verify_contained(&path)?;
        self.require_root()?;

        let _writing = self.lock();

        if !path.is_file() {
            return Err(Error::NotFound);
        }
        let dir = self.root.join(APP_DIR).join(TRASH_DIR);

        let stamp = now_millis();

        // One bucket per deletion, holding the note at its original vault path.
        // Preserving the path is what lets `next_ref` recover the ref a trashed
        // note used, so a ref is never handed out twice — a flat
        // `<stamp>-<basename>` name destroys exactly that information.
        //
        // The destination is *claimed* with create_new rather than probed with
        // exists(): probing then renaming is a check-then-act race, and rename
        // silently replaces its destination.
        for nth in 0..MAX_TRASH_COLLISIONS {
            let bucket = if nth == 0 {
                dir.join(stamp.to_string())
            } else {
                dir.join(format!("{stamp}-{nth}"))
            };
            let target = bucket.join(rel);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            match File::create_new(&target) {
                Ok(_) => {
                    // Reserved. The rename replaces this empty placeholder.
                    fs::rename(&path, &target)?;
                    return Ok(());
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(Error::Io(e)),
            }
        }
        Err(Error::Io(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "trash name collision limit reached",
        )))
    }

    /// The etag of a vault-relative path, if it exists.
    pub fn etag(&self, rel: &str) -> Option<String> {
        let path = self.resolve(rel).ok()?;
        let meta = fs::metadata(path).ok()?;
        meta.is_file().then(|| etag_of(&meta))
    }

    /// Whether an absolute path is a note the API would expose. Used by the
    /// watcher so both agree on exactly one definition of "in the vault".
    pub fn is_visible(&self, path: &Path) -> bool {
        self.is_inside(path) && path.extension().and_then(|e| e.to_str()) == Some(NOTE_EXT)
    }

    /// Whether a path lies in the vault's visible area — under the root and free
    /// of dot-segments — regardless of extension. The watcher needs this to
    /// notice *directory* events: renaming a folder full of notes emits events
    /// only for the folder, which carries no `.md` and would otherwise vanish.
    pub fn is_inside(&self, path: &Path) -> bool {
        let Ok(rel) = path.strip_prefix(&self.root) else {
            return false;
        };
        let mut any = false;
        for component in rel.components() {
            let Component::Normal(segment) = component else {
                return false;
            };
            match segment.to_str() {
                Some(s) if !s.starts_with('.') => any = true,
                _ => return false,
            }
        }
        any
    }

    /// Vault-relative path for a watcher event, if the file is visible.
    pub fn visible_relative(&self, path: &Path) -> Option<String> {
        self.is_visible(path)
            .then(|| self.relative(path).ok())
            .flatten()
    }
}

/// Etag derived from mtime and length (§04). Opaque to the client, which only
/// ever echoes it back in `If-Match`.
fn etag_of(meta: &Metadata) -> String {
    let nanos = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}-{:x}", meta.len())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_millis(meta: &Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Stage into a temp file, fsync, then rename — hard rule 5's one write path.
///
/// The temp file is dot-prefixed so the watcher ignores it and clients never see
/// a phantom note appear mid-write. A failure at any step removes the temp file
/// rather than leaving litter behind for `walk` to trip over.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or(Error::InvalidPath)?;
    let tmp = parent.join(tmp_name());

    let staged = (|| -> io::Result<()> {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(e) = staged {
        let _ = fs::remove_file(&tmp);
        return Err(Error::Io(e));
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(Error::Io(e));
    }
    Ok(())
}

fn tmp_name() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nth = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(".register-tmp-{nanos:x}-{nth:x}")
}

fn entry_for(path: String, body: &str, meta: &Metadata) -> Entry {
    let front = frontmatter_block(body)
        .and_then(parse_frontmatter)
        .unwrap_or_default();

    Entry {
        reference: ref_from_path(&path),
        title: front.title.filter(|t| !t.trim().is_empty()),
        tags: front.tags,
        mtime: mtime_millis(meta),
        size: meta.len(),
        etag: etag_of(meta),
        path,
    }
}

/// The YAML between a leading `---` line and the next `---` line, exclusive of
/// both fences.
///
/// The closing fence must not reach the parser: YAML reads `---` as the start of
/// a second document, and serde-saphyr rejects multi-document input outright.
fn frontmatter_block(body: &str) -> Option<&str> {
    // A BOM is preserved byte-for-byte on write, per §04's losslessness
    // invariant, so it has to be stepped over here rather than stripped there.
    let body = body.strip_prefix('\u{feff}').unwrap_or(body);
    let rest = body
        .strip_prefix("---\n")
        .or_else(|| body.strip_prefix("---\r\n"))?;

    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some(&rest[..offset]);
        }
        offset += line.len();
    }
    None
}

/// Parse a frontmatter block, tolerantly.
///
/// Anything malformed yields `None` rather than an error: §04's tree must
/// survive a note an agent is halfway through writing, and one unparseable file
/// must not take down `GET /api/tree`. Note that serde-saphyr rejects duplicate
/// keys by default, so a note with two `title:` lines lands here too.
fn parse_frontmatter(yaml: &str) -> Option<Frontmatter> {
    serde_saphyr::from_str::<Frontmatter>(yaml).ok()
}

/// `notes/003-terminal-aesthetics.md` → `003`.
///
/// The filename is the source of truth for the ref, not the frontmatter field:
/// §04's invariant is `filename = ref-slug`, and a filename cannot be mistyped
/// into a different YAML scalar type the way an unquoted `ref: 003` can.
/// Collect `.md` files under `dir`, reported relative to `base`.
fn collect_notes(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect_notes(base, &path, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some(NOTE_EXT) {
            continue;
        }
        if let Ok(rel) = path.strip_prefix(base)
            && let Some(text) = rel.to_str()
        {
            out.push(text.replace('\\', "/"));
        }
    }
}

fn ref_from_path(path: &str) -> Option<String> {
    // §04 defines two dated shapes and only one of them carries a ref:
    // `notes/NNN-slug.md` and the root `000-inbox.md` do, `daily/YYYY-MM-DD.md`
    // does not. A separator check alone cannot tell them apart — `2026-08-04`
    // is digits-then-dash-then-more exactly like `003-terminal-aesthetics` —
    // so the directory is what settles it, which is how §04 states it too.
    if path.starts_with(DAILY_DIR) {
        return None;
    }
    let name = path.rsplit('/').next()?;
    // §04 treats `*.conflict-<ts>.md` as an unresolved copy to be merged into
    // the original and deleted — not a note in its own right. Giving it a ref
    // would let it shadow the note it came from, so `[[003]]` could resolve to
    // the copy, and would make it consume the next ref as well.
    if name.contains(CONFLICT_MARK) {
        return None;
    }
    let digits: String = name.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let slug = name[digits.len()..].strip_prefix('-')?;
    (!slug.is_empty()).then_some(digits)
}

#[cfg(test)]
pub(crate) mod tests;
