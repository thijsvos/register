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

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()?;
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
