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

use crate::vault::Vault;
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
    /// Nothing uncommitted.
    pub clean: bool,
    /// Commits this branch has that its upstream does not. `None` when there is
    /// no upstream — which is the normal case, since checkpoints never push.
    pub ahead: Option<u32>,
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
    let mut command = Command::new("git");
    command.arg("--no-pager");
    for setting in DISARM {
        command.arg("-c").arg(setting);
    }
    for setting in disarm_filters(root) {
        command.arg("-c").arg(setting);
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

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = hardened(root).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
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
pub fn status(root: &Path) -> Option<Status> {
    if !is_repo(root) {
        return None;
    }
    let dirty = git(root, &["status", "--porcelain"])?;
    // Absent upstream is the ordinary case: checkpoints never push, so a vault
    // that has never been given a remote has nothing to be ahead of.
    let ahead = git(root, &["rev-list", "--count", "@{u}..HEAD"])
        .and_then(|count| count.trim().parse().ok());

    Some(Status {
        clean: dirty.trim().is_empty(),
        ahead,
    })
}

/// Commit everything in the vault as `checkpoint: HH:MMZ`.
///
/// Returns whether a commit was actually made — nothing to commit is a success
/// that wrote no history, not a failure.
pub fn checkpoint(root: &Path, stamp: &str) -> bool {
    if !is_repo(root) {
        return false;
    }
    // Cheaper than staging and finding out: `add -A` on a large vault is real
    // work, and the common case at idle is that nothing changed.
    match git(root, &["status", "--porcelain"]) {
        Some(dirty) if !dirty.trim().is_empty() => {}
        _ => return false,
    }

    if git(root, &["add", "-A"]).is_none() {
        return false;
    }
    // `--no-verify`: a checkpoint is the app's bookkeeping, and someone else's
    // pre-commit hook should not get a vote on whether your notes are saved.
    git(
        root,
        &[
            "commit",
            "--no-verify",
            "-m",
            &format!("checkpoint: {stamp}"),
        ],
    )
    .is_some()
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
                    if checkpoint(vault.root(), &stamp(now)) {
                        println!("register · checkpoint: {}", stamp(now));
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
