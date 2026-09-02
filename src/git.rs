//! Git checkpoints (§08 P12) — off unless the vault asks for them.
//!
//! Two rules shape everything here. **Never push**: a checkpoint is local
//! history, and pushing is a decision about somebody else's repository. And
//! **never touch a repository that is not a vault's own** — every command runs
//! with `-C <vault>`, so a vault nested inside another repo checkpoints itself
//! or not at all.
//!
//! `std::process::Command`, not a git library: this needs `add`, `commit`,
//! `status` and `rev-list`, and rule 6 prices a libgit2 binding well above four
//! subprocess calls that the user can run by hand to see what happened.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::broadcast;
use tokio::time::{Instant, timeout_at};

use crate::vault::{Vault, Written, file_etag};
use crate::watch::Event;

/// How long the vault must be still before a checkpoint is taken.
///
/// §08 P12 says "after idle" without a number. Ninety seconds is long enough
/// that a writing session is one commit rather than forty, and short enough
/// that closing the laptop mid-thought still leaves the thought in history.
const IDLE: Duration = Duration::from_secs(90);

/// What the status bar shows (§02b Screen 1's GIT field).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The branch HEAD is on, or `None` when detached.
    ///
    /// `symbolic-ref` rather than `rev-parse --abbrev-ref`, which answers with
    /// the literal string "HEAD" on a detached head — a branch name that looks
    /// real, sorts oddly and is not one.
    pub branch: Option<String>,
    /// Nothing uncommitted.
    pub clean: bool,
    /// Paths with an index entry that differs from HEAD — `git status --short`'s
    /// first column, drawn as `+`.
    pub staged: u32,
    /// Paths whose worktree differs from the index — the second column, `~`.
    /// A path can be both: `MM` is staged *and* modified, and counting it once
    /// in each is what makes the marks add up to what git shows.
    pub modified: u32,
    /// Paths git is not tracking — `??`, drawn as `?`.
    pub untracked: u32,
    /// Commits this branch has that its upstream does not. `None` when there is
    /// no upstream — which is the normal case, since checkpoints never push.
    pub ahead: Option<u32>,
}

/// Count `git status --porcelain` lines by which column carries the change.
///
/// Returns `(staged, modified, untracked)`. The format is two status columns
/// then a space then the path: `X` is the index against HEAD, `Y` is the
/// worktree against the index, and `??` is untracked.
///
/// Anything that is not a space counts, rather than a list of the letters we
/// expect. `R` (rename), `C` (copy) and `U` (unmerged) are all real states, and
/// a whitelist would silently drop the ones nobody thought of — reporting a
/// clean-looking `MAIN` for a vault mid-rename. An unmerged `UU` therefore
/// counts in both columns, which is honest: it needs work on both sides.
fn tally(porcelain: &str) -> (u32, u32, u32) {
    let mut staged = 0;
    let mut modified = 0;
    let mut untracked = 0;

    for line in porcelain.lines() {
        // Not `trim()`: a leading space is the first status column, and
        // trimming it turns ` M` (worktree-modified) into `M ` (staged).
        let mut columns = line.chars();
        let (Some(x), Some(y)) = (columns.next(), columns.next()) else {
            continue;
        };
        if x == '?' && y == '?' {
            untracked += 1;
            continue;
        }
        if x != ' ' {
            staged += 1;
        }
        if y != ' ' {
            modified += 1;
        }
    }

    (staged, modified, untracked)
}

/// Config keys whose values git executes as commands.
///
/// **A repository's `.git/config` is code.** Anyone who hands you a vault — a
/// zip, a shared folder, an agent's output — also hands you these, and they run
/// as you the moment git touches the repository. `core.fsmonitor` was a working
/// unauthenticated RCE here: it fires on `git status`, which `/api/tree` calls
/// on every request, so opening the UI on someone else's vault was enough.
///
/// A command-line `-c` outranks every config file, so setting each of these to
/// something inert is what makes running git in a repository we did not create
/// survivable. Ordered as git documents them, so the next reader can diff this
/// against `git-config(1)` and see what is missing.
const DISARM: &[&str] = &[
    // Runs on `status` and `add` — the one that was exploitable.
    "core.fsmonitor=",
    // Hooks. `--no-verify` only skips pre-commit and commit-msg; post-commit
    // still fires, which was the second working exploit.
    "core.hooksPath=/dev/null",
    // Pagers and editors are commands. No tty here, but that is a property of
    // how we happen to call it, not a guarantee.
    "core.pager=cat",
    "core.editor=true",
    "sequence.editor=true",
    // Only reachable on network operations, which this never performs — set
    // anyway, because "unreachable" is a claim about today's call sites.
    "core.sshCommand=true",
    "core.askPass=",
    "credential.helper=",
    // Diff drivers run on `add` and `status` when .gitattributes asks.
    "core.externalDiff=",
    "diff.external=",
    // A signed checkpoint would run gpg.program; the vault chooses both.
    "commit.gpgsign=false",
    "gpg.program=true",
];

/// `git`, with everything that would let the repository run code turned off.
///
/// See [`DISARM`]. `filter.*` is handled separately in [`disarm_filters`],
/// because those keys are named by the attacker and cannot be listed in advance.
pub(crate) fn hardened(root: &Path) -> Command {
    hardened_for(root, true)
}

/// The same, but skipping the filter lookup for subcommands that cannot run one.
///
/// `disarm_filters` costs a process, and `/api/tree` runs three git commands per
/// request. Only `status`, `add` and `commit` put content through a filter, so
/// the other two pay nothing — measured as the difference between four and six
/// spawns per tree request.
fn hardened_for(root: &Path, runs_filters: bool) -> Command {
    let mut command = Command::new("git");
    command.arg("--no-pager");
    for setting in DISARM {
        command.arg("-c").arg(setting);
    }
    if runs_filters {
        for setting in disarm_filters(root) {
            command.arg("-c").arg(setting);
        }
    }
    // Ambient git state overrides `-C` entirely, so a server started from inside
    // a rebase or a hook would otherwise operate on that repository instead.
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
        "GIT_NAMESPACE",
        "GIT_CONFIG",
        "GIT_ASKPASS",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_EXTERNAL_DIFF",
        "GIT_PAGER",
        "GIT_EDITOR",
    ] {
        command.env_remove(name);
    }
    command.arg("-C").arg(root);
    command
}

/// `-c` settings that neutralise every clean/smudge/process filter the
/// repository defines.
///
/// `filter.<name>.clean` runs on `git add` **and on `git status`**, which
/// normalises the worktree through it to decide whether a file is modified. The
/// name is chosen by whoever wrote the config, so unlike [`DISARM`] it cannot be
/// a constant — it has to be read back. Reading configuration executes nothing,
/// so this lookup is itself safe, and it runs with `--no-pager` and no ambient
/// git environment for the same reasons as everything else.
fn disarm_filters(root: &Path) -> Vec<String> {
    let Ok(out) = Command::new("git")
        .args(["--no-pager", "-C"])
        .arg(root)
        .args(["config", "--local", "--name-only", "--list"])
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|key| {
            key.starts_with("filter.")
                && (key.ends_with(".clean")
                    || key.ends_with(".smudge")
                    || key.ends_with(".process"))
        })
        // `cat` for clean/smudge is the identity filter, so a repository that
        // legitimately uses one still reports honest status rather than errors.
        // `.process` has no inert value, so it is emptied and git falls back.
        .map(|key| {
            if key.ends_with(".process") {
                format!("{key}=")
            } else {
                format!("{key}=cat")
            }
        })
        .collect()
}

/// Whether this subcommand puts worktree content through a clean/smudge filter.
fn runs_filters(args: &[&str]) -> bool {
    matches!(args.first(), Some(&"status" | &"add" | &"commit" | &"diff"))
}

/// `git`, keeping what it said when it fails.
///
/// Every caller below asks a *question* and is content with "no answer" — but a
/// checkpoint that cannot commit has to be able to say why, and the reason is
/// on stderr. Kept whole rather than summarised: git's own refusal carries the
/// fix with it ("Please tell me who you are" is followed by the two
/// `git config` lines that solve it), and an operator reading a log wants those.
fn try_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = hardened_for(root, runs_filters(args))
        .args(args)
        .output()
        .map_err(|why| format!("could not run git: {why}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }

    let said = String::from_utf8_lossy(&out.stderr).trim().to_owned();
    Err(if said.is_empty() {
        // A failure with nothing on stderr still has to name itself, or the
        // message is "checkpoint refused:" and a blank line.
        format!(
            "git {} exited {}",
            args.first().copied().unwrap_or("?"),
            out.status
        )
    } else {
        said
    })
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    try_git(root, args).ok()
}

/// Whether the vault is a git repository *in its own right*.
///
/// `--show-toplevel` rather than `--is-inside-work-tree`: a vault inside a
/// larger repository would answer yes to the latter, and checkpointing there
/// would commit whatever else that repository contains.
pub fn is_repo(root: &Path) -> bool {
    let Some(top) = git(root, &["rev-parse", "--show-toplevel"]) else {
        return false;
    };
    let Ok(top) = Path::new(top.trim()).canonicalize() else {
        return false;
    };
    root.canonicalize().map(|here| here == top).unwrap_or(false)
}

/// The vault's git state, or `None` when it is not a repository of its own.
///
/// Uncached by design: the answer is three subprocesses and `Vault` is what
/// knows when the vault last changed, so the caching lives there.
pub fn status(root: &Path) -> Option<Status> {
    if !is_repo(root) {
        return None;
    }
    let dirty = git(root, &["status", "--porcelain"])?;
    // Absent upstream is the ordinary case: checkpoints never push, so a vault
    // that has never been given a remote has nothing to be ahead of.
    let ahead = git(root, &["rev-list", "--count", "@{u}..HEAD"])
        .and_then(|count| count.trim().parse().ok());
    // Fails on a detached head, which is what `None` is for. An unborn branch —
    // `git init` with no commit yet — still answers, so a fresh vault reads as
    // its branch rather than as nothing.
    let branch = git(root, &["symbolic-ref", "--short", "HEAD"])
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty());

    let (staged, modified, untracked) = tally(&dirty);

    Some(Status {
        branch,
        // Still derived from the raw output rather than from the tally, so
        // "clean" cannot start disagreeing with the marks if `tally` ever drops
        // a state it does not recognise.
        clean: dirty.trim().is_empty(),
        staged,
        modified,
        untracked,
        ahead,
    })
}

/// Who changed a path, as far as this process can tell (§08 P12).
///
/// Not "human" and "agent": the server cannot see who is at the keyboard. What
/// it can see is whether a write came *through* it — a save in the app, a move,
/// a deletion — or arrived on disk from anywhere else: an agent, an editor, a
/// sync client. `Both` is one path written through the app and then changed
/// from outside before the checkpoint caught up. A checkpoint carries this as
/// one trailer per path, so history can answer the question later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Who {
    You,
    Outside,
    Both,
}

impl Who {
    /// The trailer key: `You: notes/014-x.md`.
    fn key(self) -> &'static str {
        match self {
            Self::You => "You",
            Self::Outside => "Outside",
            Self::Both => "Both",
        }
    }

    /// The word in the subject: `checkpoint: 14:07Z · 2 outside`.
    fn word(self) -> &'static str {
        match self {
            Self::You => "you",
            Self::Outside => "outside",
            Self::Both => "both",
        }
    }
}

/// The order the message lists them in — what you did, then what you and
/// somebody else did, then what arrived from outside.
const WHO: [Who; 3] = [Who::You, Who::Both, Who::Outside];

/// Who changed `path`, given what this process remembers writing.
///
/// A recorded etag that still matches is the app's own write, untouched since.
/// One that does not match — or a path the app removed that is back — has been
/// changed from outside as well, in either order.
fn attribute(root: &Path, path: &str, written: &Written) -> Who {
    match written.get(path) {
        None => Who::Outside,
        Some(None) => {
            if root.join(path).is_file() {
                Who::Both
            } else {
                Who::You
            }
        }
        Some(Some(left)) => match file_etag(&root.join(path)) {
            Some(now) if &now == left => Who::You,
            _ => Who::Both,
        },
    }
}

/// One entry of `git status --porcelain -z`: the two status columns, and the
/// path. `-z` rather than the line format so a path comes back byte-exact —
/// the line format quotes anything unusual, and a quoted path is not the path.
struct Entry {
    status: String,
    path: String,
}

/// Every path `git status --porcelain -z` reports as changed.
///
/// A rename or copy carries its source in the field after the entry; both
/// ends changed, so both are kept.
fn entries(porcelain: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    let mut fields = porcelain.split('\0');
    while let Some(field) = fields.next() {
        // `XY path`: two columns, a space, then at least one byte of path.
        if field.len() < 4 || !field.is_char_boundary(3) {
            continue;
        }
        let (status, path) = field.split_at(3);
        let status = status[..2].to_owned();
        let moved = status.contains(['R', 'C']);
        out.push(Entry {
            status: status.clone(),
            path: path.to_owned(),
        });
        if moved && let Some(source) = fields.next() {
            out.push(Entry {
                status,
                path: source.to_owned(),
            });
        }
    }
    out
}

/// The commit message: when, how many of each, then one trailer per path.
///
/// `You: notes/014-x.md` is a git trailer, so `git log --format=%(trailers)`
/// and `git interpret-trailers` both read it back. A path that cannot sit on
/// one line — a newline in a filename is legal — is counted in the subject and
/// left out of the trailers, which is the honest shape of "this one cannot be
/// named here".
fn message(stamp: &str, changes: &[(String, Who)]) -> String {
    let mut subject = format!("checkpoint: {stamp}");
    for who in WHO {
        let count = changes.iter().filter(|(_, by)| *by == who).count();
        if count > 0 {
            subject.push_str(&format!(" · {count} {}", who.word()));
        }
    }

    let mut trailers = String::new();
    for who in WHO {
        let mut paths: Vec<&str> = changes
            .iter()
            .filter(|(path, by)| *by == who && !path.contains(['\n', '\r']))
            .map(|(path, _)| path.as_str())
            .collect();
        paths.sort_unstable();
        for path in paths {
            trailers.push_str(&format!("{}: {path}\n", who.key()));
        }
    }

    if trailers.is_empty() {
        format!("{subject}\n")
    } else {
        format!("{subject}\n\n{trailers}")
    }
}

/// What a checkpoint attempt did.
///
/// Three answers, not two, and the third is the whole reason this type exists.
/// This used to be a `bool` and the caller consumed it with an `if` and no
/// `else`, so "there was nothing to commit" and "git refused to commit" were
/// the same silence. In a container the second is not an edge case but the
/// guaranteed outcome: the image sets no `user.name` or `user.email`, so every
/// commit fails — and a vault with `"checkpoints": true` accrued no history at
/// all while the setting sat there looking enabled.
#[derive(Debug, PartialEq, Eq)]
pub enum Checkpoint {
    /// History was written.
    Committed,
    /// Nothing to write: not a repository of its own, or a clean tree.
    Nothing,
    /// Git would not, and this is what it said.
    Refused(String),
}

/// Commit everything in the vault as `checkpoint: HH:MMZ`, saying beside each
/// path whether it was written through the app or from outside it — `written`
/// being what the app remembers writing since the last checkpoint.
pub fn checkpoint(root: &Path, stamp: &str, written: &Written) -> Checkpoint {
    if !is_repo(root) {
        return Checkpoint::Nothing;
    }
    // Cheaper than staging and finding out: `add -A` on a large vault is real
    // work, and the common case at idle is that nothing changed.
    //
    // `--untracked-files=all`, because the default reports a new folder as one
    // entry (`?? areas/`) and the trailers name files: a folder an agent just
    // created would otherwise be one line saying nothing about what is in it.
    let changed = match git(
        root,
        &["status", "--porcelain", "-z", "--untracked-files=all"],
    ) {
        Some(dirty) => entries(&dirty),
        None => return Checkpoint::Nothing,
    };
    if changed.is_empty() {
        return Checkpoint::Nothing;
    }

    // Your index is yours. `add -A` sweeps whatever you staged with `git add -p`
    // into the app's commit, which quietly destroys work you were composing —
    // and a checkpoint is bookkeeping, so it has no business being the thing
    // that decides your next commit. It stands aside instead, and says so, and
    // resumes on its own the moment you have finished.
    //
    // Read from the porcelain already in hand rather than by asking again: the
    // first column is the index, and anything but a space or `?` there is
    // something staged.
    if changed.iter().any(|entry| staged(&entry.status)) {
        return Checkpoint::Refused(
            "something is staged, and a checkpoint would commit it. Nothing was written; \
             checkpoints resume once your index is clear."
                .to_owned(),
        );
    }

    // Attributed before `add -A` moves anything, against the tree as it is.
    let changes: Vec<(String, Who)> = changed
        .into_iter()
        .map(|entry| {
            let who = attribute(root, &entry.path, written);
            (entry.path, who)
        })
        .collect();

    if let Err(why) = try_git(root, &["add", "-A"]) {
        return Checkpoint::Refused(why);
    }
    // `--no-verify`: a checkpoint is the app's bookkeeping, and someone else's
    // pre-commit hook should not get a vote on whether your notes are saved.
    // `--cleanup=verbatim`: the trailers are read back by path, and git's
    // default cleanup trims trailing whitespace — a filename may end in one.
    //
    // A refusal here leaves the tree staged. That is the existing behaviour of
    // `add -A` and not made worse by reporting it — and the roadmap already
    // carries the entry about checkpoints sweeping the staging area.
    let committed = try_git(
        root,
        &[
            "commit",
            "--no-verify",
            "--cleanup=verbatim",
            "-m",
            &message(stamp, &changes),
        ],
    );
    match committed {
        Ok(_) => Checkpoint::Committed,
        Err(why) => Checkpoint::Refused(why),
    }
}

/// Is this porcelain entry something the user put in the index?
///
/// `XY`, where X is the index and Y the working tree. A space means unchanged
/// there and `?` is the untracked marker — `??` is a new file nobody has
/// staged, which is the ordinary state of a vault being written in and must
/// not stand a checkpoint down.
fn staged(status: &str) -> bool {
    !matches!(status.as_bytes().first(), None | Some(b' ') | Some(b'?'))
}

/// Whether the vault has asked for checkpoints.
///
/// Read from `.register/config.json` at the moment it is needed rather than at
/// startup, so turning it on in §02b Screen 6 takes effect without restarting
/// the server. Off unless the file says otherwise — §08 P12 is explicit that
/// this is "behind config flags, OFF by default", and silently rewriting
/// somebody's git history is not a default.
pub fn checkpoints_enabled(config: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(config)
        .ok()
        .and_then(|value| {
            value
                .get("checkpoints")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false)
}

/// `14:07Z` — the stamp §08 P12 asks a checkpoint message to carry.
pub fn stamp(seconds_since_epoch: i64) -> String {
    let rest = seconds_since_epoch.rem_euclid(86_400);
    format!("{:02}:{:02}Z", rest / 3600, (rest / 60) % 60)
}

/// Commits the vault after it has been quiet for a while (§08 P12).
///
/// Driven by the same event stream the UI reads, so it sees exactly what the
/// watcher saw — an agent's write and a human's save alike. Dropping the handle
/// stops it, which is what ties its life to the server's.
pub struct Checkpointer {
    _task: tokio::task::JoinHandle<()>,
}

impl Checkpointer {
    pub fn start(vault: Arc<Vault>, events: broadcast::Receiver<Event>) -> Self {
        Self::with_idle(vault, events, IDLE)
    }

    /// The same thing with the quiet period named, so a test does not have to
    /// wait ninety seconds to find out whether this works.
    pub fn with_idle(
        vault: Arc<Vault>,
        mut events: broadcast::Receiver<Event>,
        idle: Duration,
    ) -> Self {
        let task = tokio::spawn(async move {
            loop {
                // Nothing to checkpoint until something changes. A lagging
                // receiver has still missed changes, so it counts as one.
                match events.recv().await {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }

                // Wait out the quiet. Every further event pushes the deadline,
                // so a writing session commits once at the end of it rather
                // than once per keystroke that reached disk.
                loop {
                    let deadline = Instant::now() + idle;
                    match timeout_at(deadline, events.recv()).await {
                        // Still busy: start the wait again.
                        Ok(Ok(_)) | Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                        Ok(Err(broadcast::error::RecvError::Closed)) => return,
                        Err(_) => break,
                    }
                }

                let vault = vault.clone();
                // Off the runtime: `git add -A` on a large vault is real work,
                // and this thread is the one serving the UI.
                let _ = tokio::task::spawn_blocking(move || {
                    // Read at the moment of use, so turning checkpoints on in
                    // the settings screen does not need a restart.
                    let config = vault.read_config().unwrap_or_default();
                    if !checkpoints_enabled(&config) {
                        return;
                    }
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    // A copy, and forgotten only once it is history: a write
                    // that lands while git is busy stays remembered for the
                    // next checkpoint, and a refusal leaves everything
                    // remembered, since nothing was committed.
                    let written = vault.written();
                    match checkpoint(vault.root(), &stamp(now), &written) {
                        Checkpoint::Committed => {
                            vault.forget_written(&written);
                            println!("register · checkpoint: {}", stamp(now));
                        }
                        // The ordinary idle tick. History accrues silently and
                        // usefully, and saying "nothing to do" every ninety
                        // seconds would be neither. A clean tree means what the
                        // app wrote is already committed — by hand — so the
                        // record is spent either way.
                        Checkpoint::Nothing => vault.forget_written(&written),
                        // stderr, because this is the one outcome the operator
                        // has to act on, and `docker logs` is where they will
                        // be looking when they wonder where their history went.
                        Checkpoint::Refused(why) => {
                            eprintln!("register · checkpoint refused:\n{why}");
                        }
                    }
                })
                .await;
            }
        });

        Self { _task: task }
    }
}

impl Drop for Checkpointer {
    fn drop(&mut self) {
        self._task.abort();
    }
}

#[cfg(test)]
mod tests;
