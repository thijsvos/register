//! Vault watcher: filesystem events in, coalesced change events out.
//!
//! §04 budgets an agent's edit at 100 ms from disk to repaint, so the debounce
//! window is a *fixed* 50 ms measured from the first event of a burst, not a
//! quiet period that restarts on every event. A restarting timer never fires
//! under a steady write stream, which is exactly when the UI most needs to hear.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use notify::event::{AccessKind, AccessMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc};
use tokio::time::{Instant, timeout_at};

use crate::vault::Vault;

pub const DEBOUNCE: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Change {
    Created,
    Changed,
    Removed,
}

/// One coalesced change, as sent over `WS /api/events` (§04).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Event {
    #[serde(rename = "type")]
    pub change: Change,
    pub path: String,
    /// `None` for a removal — there is nothing left to tag.
    pub etag: Option<String>,
}

/// A running watcher, and nothing else: subscribers take the broadcast receiver
/// from the sender they passed in. Dropping this stops all events silently, so
/// it must be held for as long as the server runs.
pub struct Watch {
    _watcher: RecommendedWatcher,
}

impl Watch {
    pub fn start(vault: Arc<Vault>, events: broadcast::Sender<Event>) -> notify::Result<Self> {
        let (raw_tx, raw_rx) = mpsc::unbounded_channel();

        // The closure runs on notify's own OS thread; UnboundedSender::send is
        // non-blocking and needs no runtime handle.
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                let _ = raw_tx.send(res);
            })?;
        watcher.watch(vault.root(), RecursiveMode::Recursive)?;

        tokio::spawn(coalesce(vault, raw_rx, events));

        Ok(Self { _watcher: watcher })
    }
}

/// Collect raw events into 50 ms batches, one event per path per batch.
async fn coalesce(
    vault: Arc<Vault>,
    mut raw: mpsc::UnboundedReceiver<notify::Result<notify::Event>>,
    events: broadcast::Sender<Event>,
) {
    // Which notes the vault held last time we looked. This — not the event
    // kind — is what distinguishes a create from a change.
    let mut known: HashSet<String> = snapshot(&vault).await;

    let mut pending: HashSet<PathBuf> = HashSet::new();

    loop {
        // Block until a burst starts. `None` means the watcher was dropped.
        let Some(first) = raw.recv().await else {
            return;
        };
        let mut resync = absorb(&vault, first, &mut pending);

        // Fixed window from the first event, so a steady stream still flushes.
        let deadline = Instant::now() + DEBOUNCE;
        loop {
            match timeout_at(deadline, raw.recv()).await {
                Ok(Some(event)) => resync |= absorb(&vault, event, &mut pending),
                Ok(None) => break,
                Err(_) => break,
            }
        }

        let vault_for_flush = vault.clone();
        let mut taken = std::mem::take(&mut pending);
        let taken_known = std::mem::take(&mut known);
        let flushed = tokio::task::spawn_blocking(move || {
            flush(&vault_for_flush, &mut taken, taken_known, resync)
        })
        .await;
        let (batch, next_known) = match flushed {
            Ok(flushed) => flushed,
            // `flush` panicked, and `known` went with it: it was moved into the
            // closure. This used to be `unwrap_or_default()`, which put an
            // empty set here — and from then on every write to a note read as
            // a create, and deleting one the watcher had once known was dropped
            // with nothing said, for as long as the server ran. Rebuilt from
            // the filesystem instead, the way it was built to begin with.
            Err(error) => {
                eprintln!("watch: flush failed: {error}");
                (Vec::new(), snapshot(&vault).await)
            }
        };
        known = next_known;

        if !batch.is_empty() {
            // The vault moved, so whatever `git status` last answered is stale —
            // and the client is about to refetch the tree *because* of these
            // events, which is exactly the request that would otherwise be
            // served the pre-change answer out of the cache. The watcher is the
            // only thing that knows a change happened before anyone asks.
            vault.changed();
        }

        for event in batch {
            // An error here only means nobody is listening yet.
            let _ = events.send(event);
        }
    }
}

/// Every note the vault holds right now, gathered off the runtime.
///
/// A paths-only walk on purpose: `list()` would read and YAML-parse every note
/// just to collect a set of names, on a thread that must stay free. A vault
/// that cannot be walked reads as empty, which the next resync corrects.
async fn snapshot(vault: &Arc<Vault>) -> HashSet<String> {
    let vault = vault.clone();
    tokio::task::spawn_blocking(move || vault.paths().unwrap_or_default())
        .await
        .unwrap_or_default()
}

/// Record the paths a raw event touched, if they are notes the API exposes.
///
/// The event *kind* is deliberately ignored. It is not portable: on macOS a
/// write to a file that already exists reports `Create(File)`, and a delete
/// reports `Modify(Name(Any))`; on Linux an atomic save over an existing note is
/// a bare rename with no data event at all. Only the filesystem knows what
/// actually happened, so `flush` stats the path instead.
/// Returns `true` if the batch needs a full resync rather than a per-path stat.
fn absorb(
    vault: &Vault,
    event: notify::Result<notify::Event>,
    pending: &mut HashSet<PathBuf>,
) -> bool {
    let event = match event {
        Ok(event) => event,
        // The platform lost events (inotify Q_OVERFLOW, FSEvents
        // MUST_SCAN_SUBDIRS) or errored. Either way our picture is stale.
        Err(error) => {
            eprintln!("watch: {error}");
            return true;
        }
    };
    // notify signals dropped events with a rescan flag and an EMPTY path list,
    // so this must be checked before iterating or the signal is lost entirely.
    if event.need_rescan() {
        return true;
    }

    // Reading a note is not changing it.
    //
    // This is the one place the event *kind* has to be consulted, and it is
    // portable to do so here: an access is never a mutation on any platform.
    // Linux makes it load-bearing — notify subscribes to `WatchMask::OPEN`, so
    // every file the server opens to serve it produces an event. Filling the
    // corpus of a 1k-note vault therefore generated a thousand of them, which
    // overflowed the 256-slot broadcast, made the server hang up on the client
    // ("client lagged, 632 dropped; closing"), and the client's reconnect
    // re-read the whole vault — feeding the loop that caused it. macOS never
    // showed it because FSEvents does not report opens.
    //
    // `Close(Write)` is deliberately NOT dropped: it is how a completed write
    // announces itself. `Close(Read)` and `Open` are pure reads.
    if matches!(
        event.kind,
        EventKind::Access(AccessKind::Open(_) | AccessKind::Read)
            | EventKind::Access(AccessKind::Close(AccessMode::Read))
    ) {
        return false;
    }

    let mut resync = false;
    for path in event.paths {
        // A pure path predicate, so it works for removals too: `.register/`,
        // dotfiles and our own `.register-tmp-*` staging files never qualify.
        if vault.is_visible(&path) {
            pending.insert(path);
        } else if vault.is_inside(&path) {
            // A directory (or a non-note) moved inside the vault. Directory
            // events carry no `.md`, so renaming or deleting a folder of notes
            // would otherwise be completely invisible and leave `known` wrong
            // forever. Cheap to over-trigger: a resync that finds nothing new
            // emits nothing.
            resync = true;
        }
    }
    resync
}

/// Turn the batch into one event per path. Returns the events plus the updated
/// view of what the vault contains.
///
/// Runs on a blocking thread: it stats every touched path, and a resync walks
/// the whole vault.
fn flush(
    vault: &Vault,
    pending: &mut HashSet<PathBuf>,
    mut known: HashSet<String>,
    resync: bool,
) -> (Vec<Event>, HashSet<String>) {
    let mut batch: Vec<Event> = Vec::with_capacity(pending.len());

    // A directory moved, or the platform admitted it dropped events. Per-path
    // stats cannot see either, so rebuild from the filesystem and report the
    // difference.
    if resync && let Ok(current) = vault.paths() {
        for rel in current.difference(&known) {
            batch.push(Event {
                change: Change::Created,
                etag: vault.etag(rel),
                path: rel.clone(),
            });
        }
        for rel in known.difference(&current) {
            batch.push(Event {
                change: Change::Removed,
                path: rel.clone(),
                etag: None,
            });
        }
        known = current;
    }

    let already: HashSet<String> = batch.iter().map(|e| e.path.clone()).collect();

    for path in pending.drain() {
        let Some(rel) = vault.visible_relative(&path) else {
            continue;
        };
        if already.contains(&rel) {
            continue;
        }
        let etag = vault.etag(&rel);

        let change = match (etag.is_some(), known.contains(&rel)) {
            (true, true) => Change::Changed,
            (true, false) => {
                known.insert(rel.clone());
                Change::Created
            }
            (false, true) => {
                known.remove(&rel);
                Change::Removed
            }
            // Appeared and vanished inside one window: nothing to report.
            (false, false) => continue,
        };

        batch.push(Event {
            change,
            path: rel,
            etag,
        });
    }

    batch.sort_by(|a, b| a.path.cmp(&b.path));
    (batch, known)
}

#[cfg(test)]
mod tests;
