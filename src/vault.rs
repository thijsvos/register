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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::git;

/// How long a cached `git status` may be reused.
///
/// A quarter of a second collapses a burst of tree fetches and is far below
/// anything a reader could perceive in a status field. It is a backstop rather
/// than the main guard: [`Vault::forget_git`] clears the answer the moment the
/// vault changes, so the staleness a TTL alone would allow — fetch, save, fetch
/// again inside the window, and read the pre-save state — cannot happen. What
/// the window covers is the change the watcher cannot see, because it watches
/// `.md` files: a `git add` or `git commit` run by hand touches `.git` and
/// nothing else.
const GIT_TTL: Duration = Duration::from_millis(250);

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

/// A file `GET /api/file` will serve out of the vault, by its magic number.
///
/// An allowlist rather than a passthrough, for the reason §03 gives about
/// fonts: the vault is a folder anyone can write to, and a served byte stream
/// the browser decides how to interpret is a wider surface than this product
/// wants. A `.md` renamed `.png`, an HTML file, a shell script — none of them
/// match anything here, so all of them are refused rather than served with a
/// guess.
pub struct MediaFormat {
    pub media_type: &'static str,
    /// Every `(offset, bytes)` pair must match. A list rather than a prefix
    /// because WebP and AVIF name themselves *after* a length field, so
    /// `starts_with` — which is all the font table needs — cannot see them.
    magic: &'static [(usize, &'static [u8])],
}

/// What a note can reasonably reference and a browser can render natively.
///
/// **SVG is deliberately absent.** It is XML that can carry script, and while
/// the CSP would block that today, "an allowlist of containers, not a
/// passthrough" is the principle — SVG does not earn an exception on the day
/// this endpoint is born. Parked in `docs/ROADMAP.md` with its own trigger.
const MEDIA_FORMATS: &[MediaFormat] = &[
    MediaFormat {
        media_type: "image/png",
        magic: &[(0, b"\x89PNG\r\n\x1a\n")],
    },
    MediaFormat {
        media_type: "image/jpeg",
        magic: &[(0, &[0xFF, 0xD8, 0xFF])],
    },
    MediaFormat {
        media_type: "image/gif",
        magic: &[(0, b"GIF87a")],
    },
    MediaFormat {
        media_type: "image/gif",
        magic: &[(0, b"GIF89a")],
    },
    // RIFF container: "RIFF" then four bytes of length, then the form type.
    MediaFormat {
        media_type: "image/webp",
        magic: &[(0, b"RIFF"), (8, b"WEBP")],
    },
    // ISO-BMFF: a four-byte box length, then "ftyp", then the brand.
    MediaFormat {
        media_type: "image/avif",
        magic: &[(4, b"ftypavif")],
    },
    MediaFormat {
        media_type: "application/pdf",
        magic: &[(0, b"%PDF-")],
    },
];

/// Which servable format `bytes` is, by content — never by extension.
pub fn media_format(bytes: &[u8]) -> Option<&'static MediaFormat> {
    MEDIA_FORMATS.iter().find(|format| {
        format.magic.iter().all(|(at, want)| {
            bytes
                .get(*at..at.saturating_add(want.len()))
                .is_some_and(|found| found == *want)
        })
    })
}
/// §04's dated-log directory. Its filenames are dates, not refs.
const DAILY_DIR: &str = "daily/";
/// Marks an unresolved conflict copy (§04).
const CONFLICT_MARK: &str = ".conflict-";
const NOTE_EXT: &str = "md";
/// The largest file `GET /api/file` will serve, matching the router's own
/// request-body limit so the two halves of the API refuse at the same size.
/// The read is not streamed — nothing in this crate streams, and adding it
/// means a new dependency — so this is also the allocation ceiling.
const MAX_MEDIA_BYTES: u64 = 16 * 1024 * 1024;
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
    /// Inside the vault and readable, but not a format this app hands to a
    /// browser. See `MEDIA_FORMATS`.
    UnsupportedMedia,
    /// The path is reachable but does not name a folder. Distinct from
    /// `NotFound` only so the body can say which of the two the request got
    /// wrong — "no such note" is a confusing answer to a request about a folder.
    NoSuchFolder,
    /// Bigger than `MAX_MEDIA_BYTES`. The file is read whole to be served, so an
    /// unbounded read is an unbounded allocation — and §06 budgets idle RAM at
    /// 50 MB for the whole process.
    TooLarge,
    /// Another `register` already holds this vault. Carries the lock's path and
    /// whatever it says, so the message can name both rather than tell somebody
    /// there is a problem and leave them to find it.
    AlreadyServed {
        lock: String,
        held: String,
    },
    Io(io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => write!(f, "path is outside the vault"),
            Self::NotFound => write!(f, "no such note"),
            Self::Conflict { current } => write!(f, "etag is stale; current is {current}"),
            Self::UnsupportedFont => write!(f, "not a woff2, woff, otf or ttf font"),
            Self::UnsupportedMedia => write!(f, "not an image or pdf this app will serve"),
            Self::NoSuchFolder => write!(f, "no such folder"),
            Self::TooLarge => write!(f, "file is larger than this app will serve"),
            Self::AlreadyServed { lock, held } => write!(
                f,
                "another register is already serving this vault ({held}).\n\
                 Two servers over one vault race on every write, so this one is \
                 stopping.\n\
                 If that process is gone, the claim is stale: delete {lock}"
            ),
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

/// What a folder deletion moved (`DELETE /api/folder/{path}`, §04 Rev P).
///
/// The counts are separated because the client can only predict one of them: it
/// confirms against the notes the INDEX draws, and everything else in the folder
/// — images, PDFs, anything not `.md` — is invisible to it. Reporting both is
/// what lets the notice say what actually happened rather than repeating the
/// guess the confirm was built on.
///
/// `bucket` is where it all went, vault-relative, because "deleted" is a lie
/// here — §04 never hard-deletes, and a message that does not say where to look
/// makes a recoverable operation feel final.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Trashed {
    pub notes: u32,
    pub files: u32,
    pub bucket: String,
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
    /// How long [`Vault::git_status`] may reuse an answer.
    git_ttl: Duration,
    /// The last `git status`, and when it was taken (§08 P12's GIT field).
    ///
    /// `GET /api/tree` runs three git subprocesses and the client fetches the
    /// tree after every watcher burst, so a burst of writes pays for the same
    /// answer several times over. Held here rather than in `git.rs` because
    /// this type is what a request already has, and because a process-global
    /// cache would be shared by every test in a parallel binary — an answer one
    /// test cached is not one another test should be able to read.
    git: Mutex<Option<(Instant, Option<git::Status>)>>,
}

/// Where a vault's claim lives: the temp directory, named for the vault.
///
/// Hashed rather than derived from the path text, which can contain separators
/// and is not bounded by any filename limit. `DefaultHasher` is not stable
/// across releases and does not need to be — every process that matters here is
/// the same binary running at the same moment, and the file records the real
/// path so a human reading it is never left guessing which vault it means.
fn claim_path(root: &Path) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    root.hash(&mut hasher);
    std::env::temp_dir().join(format!("register-vault-{:016x}.lock", hasher.finish()))
}

/// A vault claimed by this process. Dropping it releases the claim.
///
/// Held for the life of `register serve`, so the release is tied to the process
/// living rather than to anyone remembering to call something.
pub struct Claim {
    path: PathBuf,
}

impl Claim {
    /// Where the claim is. Tests only — production learns the path from the
    /// refusal it prints, which is the one place a human needs it.
    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Has the process named by a claim gone away?
///
/// `true` is the only answer that lets a claim be taken over, so every way of
/// not knowing — an unparsable file, no `kill` on PATH, a platform without
/// signals — answers `false` and the claim stands. Erring towards a stranded
/// lock is deliberate: that is an inconvenience with a printed fix, where a
/// stolen one is two servers writing one vault, which is the thing this whole
/// mechanism exists to prevent.
fn holder_is_gone(held: &str) -> bool {
    let Some(pid) = held
        .split_whitespace()
        .skip_while(|word| *word != "pid")
        .nth(1)
        .and_then(|word| word.parse::<u32>().ok())
    else {
        return false;
    };

    // `kill -0` sends no signal; it only reports whether the process could be
    // signalled. std exposes no `kill` and a crate for one costs an ADR under
    // hard rule 6 — where `kill` is POSIX, and busybox carries it, so the alpine
    // image in `deploy/` has it as well.
    //
    // A failure is "no such process" *or* "not permitted", told apart only by
    // locale-dependent stderr, so both read as gone here. The second is not a
    // hole: taking the claim over means deleting the file, and a claim written
    // by another user is one this process cannot delete either — the sticky bit
    // on a shared `/tmp` sees to that — so the takeover fails and the refusal
    // stands anyway.
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|probed| !probed.success())
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        // Best effort by necessity: a process being killed outright never
        // reaches this at all, which is why the claim names its pid and
        // `holder_is_gone` exists to read it.
        let _ = fs::remove_file(&self.path);
    }
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
            git_ttl: GIT_TTL,
            git: Mutex::new(None),
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

    /// Map a vault-relative request path to an absolute path inside the vault,
    /// without deciding what kind of file it names.
    ///
    /// This is the security boundary of the whole server. It rejects `..`,
    /// absolute paths, Windows separators and any dot-prefixed segment — which
    /// also makes `.register/` unreachable through the API, as §04 requires.
    ///
    /// Split out of `resolve` so `GET /api/file` can reuse **every** guard while
    /// declining only the `.md` rule. The split is deliberate and narrow:
    /// anything added here protects both callers, and the note API's definition
    /// of a note is unchanged directly below.
    fn resolve_within(&self, rel: &str) -> Result<PathBuf> {
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
        Ok(out)
    }

    /// `resolve_within` plus the one rule that makes a path a *note*.
    fn resolve(&self, rel: &str) -> Result<PathBuf> {
        let out = self.resolve_within(rel)?;
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
            git: self.git_status(),
            notes: self.list()?,
        })
    }

    /// Hold a cached git status for this long instead of [`GIT_TTL`].
    ///
    /// Tests only. A test that asserts "the second call was served from cache"
    /// otherwise races the window: under a loaded machine — a `cargo clippy`
    /// running beside it was enough — the quarter second expires between the
    /// two calls, the answer is recomputed correctly, and the assertion fails
    /// for a reason that has nothing to do with the cache.
    #[cfg(test)]
    pub fn with_git_ttl(mut self, ttl: Duration) -> Self {
        self.git_ttl = ttl;
        self
    }

    /// The vault's git state, from cache when it is still current.
    pub fn git_status(&self) -> Option<git::Status> {
        if let Ok(slot) = self.git.lock()
            && let Some((at, answer)) = slot.as_ref()
            && at.elapsed() < self.git_ttl
        {
            return answer.clone();
        }

        // Deliberately outside the lock: this spawns subprocesses, and holding
        // the mutex across them would serialise every concurrent tree request
        // behind the slowest one — which is the cost this exists to remove.
        let answer = git::status(&self.root);
        if let Ok(mut slot) = self.git.lock() {
            *slot = Some((Instant::now(), answer.clone()));
        }
        answer
    }

    /// Where this vault's claim would go. Tests only — production learns it
    /// from the `Claim` it holds or from the refusal it prints.
    #[cfg(test)]
    pub fn claim_path_for_test(&self) -> PathBuf {
        claim_path(&self.root)
    }

    /// Drop the cached git state, because the vault has changed.
    pub fn forget_git(&self) {
        if let Ok(mut slot) = self.git.lock() {
            *slot = None;
        }
    }

    /// Claim this vault for this process, or say who already has it.
    ///
    /// `vault.rs` serialises writes with an in-process `Mutex`, which is exactly
    /// enough for one server and nothing at all for two: hard rule 5 routes
    /// every write through this type, and two processes have two of it. Both
    /// would then read an etag, compare it, and rename over each other — and
    /// `create`'s "is this name free" check has the same shape, so two servers
    /// could hand out one ref.
    ///
    /// **Outside the vault**, and that is not where it started. A claim inside
    /// `.register/` is one untracked file, which is enough to make a vault under
    /// git permanently dirty for as long as the app is running — `?1` in the
    /// status bar, and `a_licensed_font_never_reaches_the_repository` failing,
    /// which is the test that exists to say the app does not touch your
    /// repository. `.gitignore` cannot fix it either: the scaffold names two
    /// directories under §08 P8, adding a third is a §04 surface change under
    /// hard rule 1, and no edit to it reaches a vault somebody already
    /// initialised. A lock is process coordination rather than anything the
    /// vault has to express, so it lives where process state belongs.
    ///
    /// The cost, stated because it is real: two processes that do not share a
    /// temp directory cannot see each other's claim. A container and its host
    /// mounting one vault is exactly that case, and this does not cover it.
    ///
    /// No crate for it: `fs4` or `fd-lock` would give real advisory locking and
    /// cost an ADR under hard rule 6, where what is wanted is a refusal at
    /// startup rather than a lock held across every write.
    ///
    /// A killed process never reaches `Drop` and leaves its claim behind, so the
    /// file names its pid and a claim whose pid is gone is taken over rather
    /// than obeyed. Without that, one `docker kill` makes a vault unstartable
    /// until a human deletes a file — a worse failure than the race this
    /// prevents, and a new one.
    pub fn claim(&self) -> Result<Claim> {
        let path = claim_path(&self.root);

        match self.take(&path) {
            Err(Error::AlreadyServed { held, .. }) if holder_is_gone(&held) => {
                // Best effort, and the permission check in the same stroke: a
                // claim this process cannot delete is one it has no business
                // taking, and the retry below then refuses on its own — with
                // whatever the file says now, which is the live holder's pid if
                // another server cleared the same stale claim first.
                let _ = fs::remove_file(&path);
                self.take(&path)
            }
            other => other,
        }
    }

    /// One attempt at the claim file. `create_new` is the mechanism — a single
    /// filesystem operation that both creates and refuses, so there is no window
    /// between asking and taking.
    fn take(&self, path: &Path) -> Result<Claim> {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(mut file) => {
                // Best effort: the claim is the file existing, not its contents.
                // A reader who cannot parse this still knows to look at the pid.
                let _ = writeln!(file, "pid {} · {}", std::process::id(), self.root.display());
                Ok(Claim {
                    path: path.to_path_buf(),
                })
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let held = fs::read_to_string(path).unwrap_or_default();
                Err(Error::AlreadyServed {
                    lock: path.display().to_string(),
                    held: held.trim().to_owned(),
                })
            }
            Err(error) => Err(Error::Io(error)),
        }
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

    /// The etag of any vault file, without reading it.
    ///
    /// So a conditional request costs a `stat` rather than a whole PNG: the
    /// handler asks this first and answers 304 before `read_media` allocates.
    pub fn media_etag(&self, rel: &str) -> Result<String> {
        let path = self.resolve_within(rel)?;
        self.verify_contained(&path)?;
        let meta = fs::metadata(&path)?;
        if !meta.is_file() {
            return Err(Error::NotFound);
        }
        Ok(etag_of(&meta))
    }

    /// A non-note file from the vault: its bytes, its format and its etag.
    ///
    /// Every guard `read` uses, minus the `.md` rule and plus two of its own —
    /// a size cap before the allocation, and a magic-number allowlist after it.
    /// The allowlist is what makes this safe to point at a folder anyone can
    /// write to: the type is decided by content, never by the extension in the
    /// request, so a `.md` renamed `.png` is refused rather than mislabelled.
    pub fn read_media(&self, rel: &str) -> Result<(Vec<u8>, &'static MediaFormat, String)> {
        let path = self.resolve_within(rel)?;
        self.verify_contained(&path)?;
        let meta = fs::metadata(&path)?;
        if !meta.is_file() {
            return Err(Error::NotFound);
        }
        // Checked against the metadata, before the read rather than after it:
        // refusing a 2 GB file is only useful if we have not already loaded it.
        if meta.len() > MAX_MEDIA_BYTES {
            return Err(Error::TooLarge);
        }
        let bytes = fs::read(&path)?;
        let format = media_format(&bytes).ok_or(Error::UnsupportedMedia)?;
        Ok((bytes, format, etag_of(&meta)))
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

    /// A path inside `.register/`, verified to be inside it.
    ///
    /// The API cannot reach `.register/` — `resolve` rejects every dot-prefixed
    /// segment — so for a long time these paths were built by joining and used
    /// directly. That is fine right up until the vault comes from somewhere
    /// else: git preserves symlinks, so a cloned vault whose
    /// `.register/config.json` or `.register/fonts/body.woff2` is a link to
    /// `/etc/passwd` had that file read and served, because nothing here did
    /// what `resolve` does for notes.
    ///
    /// Same component walk, same rule: a link anywhere in the chain, including
    /// the final one, is refused.
    fn app_file(&self, name: &str) -> Result<PathBuf> {
        let path = self.root.join(APP_DIR).join(name);
        self.verify_contained(&path)?;
        Ok(path)
    }

    /// `.register/config.json` — §04's "theme, fonts, flags". `{}` when absent,
    /// because a vault without a config has made no choices, not an error.
    pub fn read_config(&self) -> Result<String> {
        match fs::read_to_string(self.app_file(CONFIG_FILE)?) {
            Ok(text) => Ok(text),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok("{}".to_owned()),
            Err(e) => Err(Error::Io(e)),
        }
    }

    pub fn write_config(&self, body: &str) -> Result<()> {
        let _writing = self.lock();
        self.require_root()?;

        let path = self.app_file(CONFIG_FILE)?;
        // A vault made by hand rather than by `register init` has no
        // `.register/` at all, and the first setting anyone changes is where
        // that shows up.
        fs::create_dir_all(path.parent().ok_or(Error::InvalidPath)?)?;
        write_atomically(&path, body.as_bytes())
    }

    /// The stored BYOF face and its media type, if the user has loaded one.
    pub fn font(&self) -> Option<(PathBuf, &'static str)> {
        for format in FONT_FORMATS {
            let Ok(path) = self.app_file(&format!("{FONTS_DIR}/{FONT_STEM}.{}", format.extension))
            else {
                // A linked font is not served rather than being followed.
                continue;
            };
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

        let path = self.app_file(&format!("{FONTS_DIR}/{FONT_STEM}.{}", format.extension))?;
        fs::create_dir_all(path.parent().ok_or(Error::InvalidPath)?)?;
        self.verify_parent(path.parent().ok_or(Error::InvalidPath)?)?;
        write_atomically(&path, bytes)
    }

    /// §08 P9: "remove wipes it".
    pub fn remove_font(&self) -> Result<()> {
        let _writing = self.lock();
        self.remove_font_locked()
    }

    fn remove_font_locked(&self) -> Result<()> {
        for format in FONT_FORMATS {
            let Ok(path) = self.app_file(&format!("{FONTS_DIR}/{FONT_STEM}.{}", format.extension))
            else {
                continue;
            };
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
                    self.prune_empty_parents(&path);
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

    /// Move a folder and everything under it to `.register/trash/`, in **one**
    /// bucket (§04 Rev P).
    ///
    /// One bucket, not one per note, and that is the whole argument for doing
    /// this on the server. The client already holds every note path and could
    /// loop over `DELETE /api/note` — but each of those claims its own
    /// `<stamp>` directory, so one folder scatters across as many buckets as it
    /// held notes and "restore what I deleted" becomes archaeology. Here it is a
    /// single `rename` of the directory itself: atomic, one bucket, the subtree
    /// preserved at its original vault path exactly as `trash` preserves a
    /// note's, and therefore restorable by moving one directory back.
    ///
    /// The rename is also what takes **non-note files with it**. `trash` cannot
    /// name a PNG at all — it goes through `resolve`, which is `.md`-only — so a
    /// client-side loop would empty a folder of its notes and leave the images
    /// behind in a directory the INDEX now shows as gone. That is not a gap this
    /// endpoint is closing by accident: it is why the operation belongs to the
    /// folder rather than to the notes inside it. It does not reopen the
    /// read-only rule on `GET /api/file` either — that rule exists so the vault
    /// cannot *acquire* a file its own tree will never show, and this removes.
    pub fn trash_folder(&self, rel: &str) -> Result<Trashed> {
        // `resolve_within`, not `resolve`: a folder has no `.md`. Every other
        // guard applies unchanged — `..`, absolute paths, `\`, NUL and any
        // dot-prefixed segment, which is what keeps `.register/` unreachable.
        // The vault root is refused by the same rule that refuses an empty
        // path: a request has to name something, and `depth == 0` names the
        // vault itself.
        let path = self.resolve_within(rel)?;
        self.verify_contained(&path)?;
        self.require_root()?;

        let _writing = self.lock();

        if !path.is_dir() {
            return Err(Error::NoSuchFolder);
        }

        // Counted before the move, because afterwards there is nothing to count.
        // Informational only: the client's own confirm counts what the INDEX
        // shows, and the two differ by exactly the files the INDEX does not draw
        // — media above all. Reporting what actually moved is what stops those
        // two numbers from quietly disagreeing.
        let (notes, files) = tally_files(&path)?;

        let dir = self.root.join(APP_DIR).join(TRASH_DIR);
        fs::create_dir_all(&dir)?;
        let stamp = now_millis();

        for nth in 0..MAX_TRASH_COLLISIONS {
            let name = if nth == 0 {
                stamp.to_string()
            } else {
                format!("{stamp}-{nth}")
            };
            let bucket = dir.join(&name);
            // The bucket is *claimed* with `create_dir`, which fails rather than
            // succeeding when it already exists — the same claim-don't-probe
            // reasoning `trash` applies with `create_new`, for the same reason:
            // probing and then renaming is a check-then-act race, and `rename`
            // replaces its destination without a word.
            match fs::create_dir(&bucket) {
                Ok(()) => {
                    let target = bucket.join(rel);
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::rename(&path, &target)?;
                    self.prune_empty_parents(&path);
                    return Ok(Trashed {
                        notes,
                        files,
                        bucket: format!("{APP_DIR}/{TRASH_DIR}/{name}"),
                    });
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

    /// Remove directories a deletion left empty, innermost first.
    ///
    /// Without this the INDEX and the filesystem disagree in the one direction
    /// that matters: the folder is gone from the app — a folder row exists only
    /// while a note is under it — and still sitting in Finder. §04's premise is
    /// that the folder on disk *is* the product, so the two have to agree.
    ///
    /// It stops at any direct child of the root, so the §04 layout survives its
    /// own last note: emptying `notes/` must not delete `notes/`. A directory
    /// holding anything at all is left alone, `.DS_Store` included — `remove_dir`
    /// refusing a non-empty directory is the test, so nothing here can remove a
    /// file, and sweeping away somebody's leftovers is worse than an empty
    /// folder the INDEX cannot draw.
    ///
    /// Failure is not an error. The deletion has already happened and succeeded;
    /// a directory that would not go is untidy, not wrong.
    fn prune_empty_parents(&self, from: &Path) {
        let mut at = from.parent();
        while let Some(dir) = at {
            if dir.parent() == Some(self.root.as_path()) || !dir.starts_with(&self.root) {
                return;
            }
            if fs::remove_dir(dir).is_err() {
                return;
            }
            at = dir.parent();
        }
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

/// Count what is under a directory: notes, and everything else.
///
/// Dot-prefixed entries are skipped, the same rule and for the same reason as
/// `walk` — an editor swap file is not something a reader put there and not
/// something a count of their work should include. They still ride along in the
/// rename, since it moves the directory whole; they are simply not claimed to be
/// part of what was deleted.
fn tally_files(dir: &Path) -> Result<(u32, u32)> {
    let mut notes = 0;
    let mut files = 0;
    let mut stack = vec![dir.to_path_buf()];

    while let Some(at) = stack.pop() {
        for entry in fs::read_dir(&at)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some(NOTE_EXT) {
                notes += 1;
            } else {
                files += 1;
            }
        }
    }
    Ok((notes, files))
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
    let rest = after_fence(body)?;

    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        if is_fence(line) {
            return Some(&rest[..offset]);
        }
        offset += line.len();
    }
    None
}

/// What a fence line is — stated here because §04 has two readers.
///
/// `app/src/core/frontmatter.ts` matches `/^---[ \t]*\r?\n/` to open and
/// `/^---[ \t]*\r?\n?$/` to close. These two functions are that rule in Rust,
/// and `tests/compat.rs` reads one frozen fixture through both parsers so they
/// cannot quietly stop agreeing.
///
/// They had stopped. This side opened on a byte-exact `---\n` while the client
/// allowed trailing blanks, so a note beginning `--- ` — which any editor or
/// agent emits without thinking — was frontmatter to the editor and metadata to
/// nobody: `/api/tree` reported it with no title and no tags, permanently, with
/// nothing on screen saying so. `frontmatter.ts` already names that outcome for
/// a different route to it — "a note loses its identity" — and there is no
/// client-side fallback, because `tags.ts` reads tags straight off this envelope.
///
/// One deliberate narrowing came with the fix: closing used to be
/// `line.trim_end() == "---"`, and `trim_end` strips every Unicode space, so a
/// fence padded with U+00A0 closed here and not in the client. Both now say
/// spaces and tabs, which is what the format means and what a person can see.
fn after_fence(body: &str) -> Option<&str> {
    let rest = body.strip_prefix("---")?.trim_start_matches([' ', '\t']);
    rest.strip_prefix('\n')
        .or_else(|| rest.strip_prefix("\r\n"))
}

/// Whether one line — terminator included, as `split_inclusive` yields it — is a
/// fence. The last line of a file carries no terminator, hence the empty arm.
fn is_fence(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("---") else {
        return false;
    };
    matches!(rest.trim_start_matches([' ', '\t']), "" | "\n" | "\r\n")
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
