use std::fs;
use std::process::Command;

use super::*;
use crate::vault::tests::TempVault;

/// A vault that is its own git repository, with one commit in it.
fn repo(tmp: &TempVault) {
    // Each step asserted. Swallowing the exit status meant a failed `git init`
    // left a plain directory that every test below then treated as a
    // repository — and `log()` returns "" for a broken repo, so
    // `assert_eq!(log(&tmp), before)` passed as `"" == ""` while proving
    // nothing about checkpoints at all.
    let run = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(tmp.path())
            .args(args)
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    run(&["init", "--quiet"]);
    // The branch is named here rather than inherited. `git init` uses whatever
    // `init.defaultBranch` says, which is `main` on this developer's machine and
    // `master` on the CI runner — so a test asserting the branch passed locally
    // and failed there, on a fixture difference rather than on the code. Set
    // through `symbolic-ref` instead of `init -b`, which git only learned in
    // 2.28, and before the first commit so there is no branch to move.
    run(&["symbolic-ref", "HEAD", "refs/heads/main"]);
    run(&["config", "user.email", "t@e"]);
    run(&["config", "user.name", "T"]);
    tmp.put("notes/003-a.md", "---\nref: 003\n---\nBody.\n");
    run(&["add", "-A"]);
    run(&["commit", "--quiet", "-m", "first"]);

    // The fixture built what it claims to have built.
    assert!(
        tmp.path().join(".git").is_dir(),
        "no repository was created"
    );
    // And that the branch really is the one the tests name. Without this the
    // `symbolic-ref` above could stop working and every branch assertion would
    // go back to depending on whose machine it ran on.
    let head = Command::new("git")
        .arg("-C")
        .arg(tmp.path())
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .expect("git");
    assert_eq!(
        String::from_utf8_lossy(&head.stdout).trim(),
        "main",
        "the fixture is not on the branch its tests assert"
    );
}

/// The commit subjects, or `""` for a repository that has none yet.
///
/// `git log` exits non-zero on a repo with no commits, which is a legitimate
/// state here — so failure is distinguished from emptiness by checking stderr
/// rather than by ignoring the status outright.
fn log(tmp: &TempVault) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(tmp.path())
        .args(["log", "--oneline"])
        .output()
        .expect("git log");
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr);
        assert!(
            why.contains("does not have any commits"),
            "git log failed for a reason other than an empty history: {why}"
        );
        return String::new();
    }
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn a_folder_that_is_not_a_repository_is_left_alone() {
    let tmp = TempVault::new();
    tmp.put("notes/003-a.md", "---\nref: 003\n---\nBody.\n");

    assert!(!is_repo(tmp.path()));
    assert_eq!(status(tmp.path()), None);
    assert_eq!(
        checkpoint(tmp.path(), "14:07Z", &Written::new()),
        Checkpoint::Nothing
    );
}

#[test]
fn a_vault_inside_someone_elses_repository_is_not_its_own() {
    // The dangerous case: checkpointing here would `git add -A` a repository
    // that happens to contain the vault, and commit whatever else is in it.
    let outer = TempVault::new();
    repo(&outer);
    let inner = outer.path().join("nested-vault");
    fs::create_dir_all(inner.join("notes")).expect("create nested vault");

    assert!(!is_repo(&inner), "a nested folder claimed the outer repo");
    assert_eq!(
        checkpoint(&inner, "14:07Z", &Written::new()),
        Checkpoint::Nothing
    );
}

#[test]
fn a_checkpoint_commits_everything_and_says_when() {
    let tmp = TempVault::new();
    repo(&tmp);
    tmp.put("notes/004-b.md", "---\nref: 004\n---\nWritten since.\n");

    assert!(!status(tmp.path()).expect("status").clean);
    assert_eq!(
        checkpoint(tmp.path(), "14:07Z", &Written::new()),
        Checkpoint::Committed
    );

    assert!(log(&tmp).contains("checkpoint: 14:07Z"), "{}", log(&tmp));
    assert!(status(tmp.path()).expect("status").clean);
}

#[test]
fn an_idle_vault_with_nothing_to_say_writes_no_history() {
    // "History accrues silently and usefully" — a checkpoint every idle period
    // regardless of whether anything changed is neither.
    let tmp = TempVault::new();
    repo(&tmp);
    let before = log(&tmp);

    assert_eq!(
        checkpoint(tmp.path(), "14:07Z", &Written::new()),
        Checkpoint::Nothing
    );
    assert_eq!(log(&tmp), before);
}

/// A `Vault` over the same directory, for the cache that lives on it.
///
/// The window is opened wide because these tests are about *whether* an answer
/// is reused, not about when it expires. At the shipped quarter second a loaded
/// machine can spend the whole window between two calls — a `cargo clippy`
/// beside the suite was enough — and the assertion then fails on the scheduler
/// rather than on the cache.
fn opened(tmp: &TempVault) -> crate::vault::Vault {
    crate::vault::Vault::open(tmp.path())
        .expect("open vault")
        .with_git_ttl(std::time::Duration::from_secs(3600))
}

#[test]
fn the_status_a_tree_fetch_sees_is_cached_between_bursts() {
    // `GET /api/tree` runs three git subprocesses and the client fetches the
    // tree after every watcher burst, so a burst pays for one answer repeatedly.
    let tmp = TempVault::new();
    repo(&tmp);
    let vault = opened(&tmp);

    let first = vault.git_status().expect("status");
    assert!(first.clean);

    // Change the worktree without telling the vault. Only the cache can explain
    // a second answer that still says clean — which is the whole point of it.
    tmp.put("notes/004-b.md", "---\nref: 004\n---\nx\n");
    assert_eq!(vault.git_status().as_ref(), Some(&first));

    // Deterministic because the cache belongs to this `Vault` and not to the
    // process: a parallel test with its own vault cannot evict this one.
    assert!(!status(tmp.path()).expect("uncached").clean);
}

#[test]
fn the_cache_is_dropped_the_moment_the_vault_changes() {
    // What the watcher calls, and the reason a TTL alone would not do: the
    // client refetches the tree *because* of the event, and that fetch must not
    // be served the answer from before the change.
    let tmp = TempVault::new();
    repo(&tmp);
    let vault = opened(&tmp);

    assert!(vault.git_status().expect("status").clean);
    tmp.put("notes/004-b.md", "---\nref: 004\n---\nx\n");

    vault.forget_git();
    assert!(
        !vault.git_status().expect("status").clean,
        "a change the watcher saw was still answered from cache"
    );
}

#[test]
fn a_write_clears_the_cache_without_waiting_to_be_told_it_happened() {
    // The watcher is not fast enough to be the only thing that clears this, and
    // for a while it was the only thing. It answers after a 50 ms coalescing
    // window and a blocking flush; the client refetches the tree the instant a
    // save returns, milliseconds later. So every note created from the palette
    // read a GIT field describing the vault as it was before the note existed.
    // A write knows it wrote.
    let tmp = TempVault::new();
    repo(&tmp);
    let vault = opened(&tmp);

    assert!(vault.git_status().expect("status").clean);

    vault
        .write("notes/004-b.md", "---\nref: 004\n---\nx\n", None)
        .expect("write");

    // No `forget_git` here, and no watcher running: the write is what cleared
    // it. The TTL cannot be what makes this pass — `opened` pins it at an hour.
    assert!(
        !vault.git_status().expect("status").clean,
        "a note this vault wrote itself was answered from the cache that predates it"
    );
}

#[test]
fn two_vaults_do_not_answer_for_each_other() {
    let clean = TempVault::new();
    repo(&clean);
    let dirty = TempVault::new();
    repo(&dirty);
    dirty.put("notes/004-b.md", "---\nref: 004\n---\nx\n");

    // Populated in this order so a shared cache would hand the second vault the
    // first one's answer.
    assert!(opened(&clean).git_status().expect("clean").clean);
    assert!(!opened(&dirty).git_status().expect("dirty").clean);
}

#[test]
fn a_vault_that_cannot_commit_says_why_rather_than_nothing() {
    // The container case, and it is not an edge case there — `deploy/Dockerfile`
    // sets no `user.name` or `user.email`, so every commit fails. Before this,
    // `checkpoint` answered `false` for that exactly as it does for "nothing to
    // do", the caller printed on `true` only, and a vault with checkpoints
    // switched on accrued no history while the setting sat there looking
    // enabled.
    //
    // The refusal is provoked with a stale `index.lock` rather than by removing
    // the identity, and that is not the obvious choice — it is the only stable
    // one. `scaffold/tests.rs` sets `GIT_AUTHOR_*` and `GIT_COMMITTER_*` for the
    // whole test process, those outrank every config file, and Rust runs tests
    // in threads that share one environment. So an identity emptied here is
    // ignored the moment a scaffold test has run: this test passed alone,
    // passed under `cargo test git::`, and committed under the full suite.
    //
    // A left-behind lock is what a crashed git actually leaves, it fails
    // `add -A` on every platform, and no environment variable can override it.
    let tmp = TempVault::new();
    repo(&tmp);
    fs::write(tmp.path().join(".git/index.lock"), "").expect("stale lock");

    let before = log(&tmp);
    tmp.put("notes/004-b.md", "---\nref: 004\n---\nWritten since.\n");

    match checkpoint(tmp.path(), "14:07Z", &Written::new()) {
        Checkpoint::Refused(why) => {
            // Not asserted against git's exact wording, which moves between
            // versions — asserted as "there is something to read", because the
            // failure this replaces was a message that did not exist at all.
            assert!(!why.trim().is_empty(), "refused with nothing to say");
        }
        other => panic!("expected a refusal, got {other:?}"),
    }

    // And it really did not commit, so the refusal is not a lie either way.
    assert_eq!(log(&tmp), before, "history moved despite the refusal");
}

#[test]
fn a_checkpoint_never_pushes() {
    // There is no remote here, so a push would fail loudly rather than
    // silently — which is the point: the code must never reach for one.
    let tmp = TempVault::new();
    repo(&tmp);
    tmp.put("notes/004-b.md", "---\nref: 004\n---\nx\n");

    assert_eq!(
        checkpoint(tmp.path(), "14:07Z", &Written::new()),
        Checkpoint::Committed
    );
    // No upstream, so nothing to be ahead of, and the status still reads.
    let state = status(tmp.path()).expect("status");
    assert!(state.clean);
    assert_eq!(state.ahead, None);
}

#[test]
fn ahead_counts_commits_the_upstream_has_not_seen() {
    let tmp = TempVault::new();
    repo(&tmp);

    // A local "remote": enough for `@{u}` to resolve without a network.
    let bare = tmp.path().join(".upstream.git");
    Command::new("git")
        .args(["init", "--bare", "--quiet"])
        .arg(&bare)
        .output()
        .expect("git init --bare");
    for args in [
        vec!["remote", "add", "origin", bare.to_str().expect("utf-8")],
        vec!["push", "--quiet", "-u", "origin", "HEAD"],
    ] {
        Command::new("git")
            .arg("-C")
            .arg(tmp.path())
            .args(&args)
            .output()
            .expect("git");
    }

    assert_eq!(status(tmp.path()).expect("status").ahead, Some(0));

    tmp.put("notes/004-b.md", "---\nref: 004\n---\nx\n");
    assert_eq!(
        checkpoint(tmp.path(), "14:07Z", &Written::new()),
        Checkpoint::Committed
    );

    let state = status(tmp.path()).expect("status");
    assert!(state.clean, "the checkpoint left the tree dirty");
    assert_eq!(
        state.ahead,
        Some(1),
        "the checkpoint did not count as ahead"
    );
}

#[test]
fn the_stamp_is_utc_hours_and_minutes() {
    for (seconds, expected) in [
        (0_i64, "00:00Z"),
        (50_820, "14:07Z"),
        (1_785_921_400, "09:16Z"),
        (86_399, "23:59Z"),
    ] {
        assert_eq!(stamp(seconds), expected, "stamp({seconds})");
    }
}

#[test]
fn checkpoints_are_off_unless_the_vault_asks() {
    // §08 P12: "behind config flags, OFF by default". Anything unreadable,
    // absent or not a boolean means off — rewriting history is not a default.
    for config in [
        "{}",
        r#"{"scheme":"dark"}"#,
        r#"{"checkpoints":false}"#,
        r#"{"checkpoints":"yes"}"#,
        "not json at all",
        "",
    ] {
        assert!(!checkpoints_enabled(config), "{config:?} enabled it");
    }
    assert!(checkpoints_enabled(r#"{"checkpoints":true}"#));
    assert!(checkpoints_enabled(
        r#"{"scheme":"dark","checkpoints":true}"#
    ));
}

// ------------------------------------------------------ who changed what

/// The whole message of the newest commit, trailers included.
fn last_message(tmp: &TempVault) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(tmp.path())
        .args(["log", "-1", "--format=%B"])
        .output()
        .expect("git log");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn a_checkpoint_says_who_changed_what() {
    let tmp = TempVault::new();
    repo(&tmp);
    let vault = opened(&tmp);

    // Through the app.
    vault
        .write(
            "notes/004-b.md",
            "---\nref: 004\n---\nSaved in the app.\n",
            None,
        )
        .expect("write");
    // From outside — an agent, an editor, anything that is not this process.
    tmp.put(
        "notes/005-c.md",
        "---\nref: 005\n---\nWritten by an agent.\n",
    );
    // Through the app, then rewritten from outside before the checkpoint. A
    // different length, so the etag cannot collide inside one mtime tick.
    vault
        .write("notes/006-d.md", "---\nref: 006\n---\nFirst.\n", None)
        .expect("write");
    tmp.put(
        "notes/006-d.md",
        "---\nref: 006\n---\nThen an agent changed it.\n",
    );

    let written = vault.written();
    assert_eq!(
        checkpoint(tmp.path(), "14:07Z", &written),
        Checkpoint::Committed
    );

    let message = last_message(&tmp);
    assert!(
        message.starts_with("checkpoint: 14:07Z · 1 you · 1 both · 1 outside\n"),
        "{message}"
    );
    assert!(message.contains("\nYou: notes/004-b.md\n"), "{message}");
    assert!(message.contains("\nBoth: notes/006-d.md\n"), "{message}");
    assert!(message.contains("\nOutside: notes/005-c.md\n"), "{message}");
}

#[test]
fn with_nothing_remembered_everything_is_from_outside() {
    // The bare call — what a checkpoint knows when the app wrote nothing.
    let tmp = TempVault::new();
    repo(&tmp);
    tmp.put("notes/004-b.md", "---\nref: 004\n---\none\n");
    tmp.put("notes/005-c.md", "---\nref: 005\n---\ntwo\n");

    assert_eq!(
        checkpoint(tmp.path(), "14:07Z", &Written::new()),
        Checkpoint::Committed
    );
    let message = last_message(&tmp);
    assert!(
        message.starts_with("checkpoint: 14:07Z · 2 outside\n"),
        "{message}"
    );
    assert!(message.contains("\nOutside: notes/004-b.md\n"), "{message}");
    assert!(message.contains("\nOutside: notes/005-c.md\n"), "{message}");
    assert!(!message.contains("You:"), "{message}");
}

#[test]
fn a_new_folder_is_named_file_by_file() {
    // `git status` reports an untracked folder as one entry, `?? areas/`, and
    // a trailer naming a folder says nothing about which notes arrived in it.
    let tmp = TempVault::new();
    repo(&tmp);
    tmp.put("areas/x/010-a.md", "---\nref: 010\n---\na\n");
    tmp.put("areas/x/011-b.md", "---\nref: 011\n---\nb\n");

    assert_eq!(
        checkpoint(tmp.path(), "14:07Z", &Written::new()),
        Checkpoint::Committed
    );
    let message = last_message(&tmp);
    assert!(
        message.contains("\nOutside: areas/x/010-a.md\n"),
        "{message}"
    );
    assert!(
        message.contains("\nOutside: areas/x/011-b.md\n"),
        "{message}"
    );
    assert!(!message.contains("Outside: areas/\n"), "{message}");
}

#[test]
fn a_committed_write_is_forgotten_and_a_later_one_is_not() {
    let tmp = TempVault::new();
    repo(&tmp);
    let vault = opened(&tmp);

    vault
        .write("notes/004-b.md", "---\nref: 004\n---\nfirst\n", None)
        .expect("write");
    let copy = vault.written();
    // Written again after the copy was taken — a different length, so the
    // record is a different etag — and once more on a path the copy never saw.
    vault
        .write(
            "notes/004-b.md",
            "---\nref: 004\n---\nfirst, then more\n",
            None,
        )
        .expect("write");
    vault
        .write("notes/005-c.md", "---\nref: 005\n---\nlater\n", None)
        .expect("write");

    vault.forget_written(&copy);
    let left = vault.written();
    assert!(
        left.contains_key("notes/004-b.md"),
        "the newer write was forgotten with the older one"
    );
    assert_ne!(left["notes/004-b.md"], copy["notes/004-b.md"]);
    assert!(left.contains_key("notes/005-c.md"));

    // And forgetting what is now remembered empties it.
    vault.forget_written(&left);
    assert!(vault.written().is_empty());
}

#[test]
fn what_the_app_moved_trashed_and_restored_is_its_own() {
    // Every write the product makes goes through `vault.rs` (hard rule 5), so
    // every one of them has to leave a record — a move, a trash and a restore
    // included, or the checkpoint calls the app's own housekeeping an outside
    // edit. `repo()` committed `notes/003-a.md`; this moves it about.
    let tmp = TempVault::new();
    repo(&tmp);
    let vault = opened(&tmp);

    vault
        .rename("notes/003-a.md", "notes/003-moved.md")
        .expect("rename");
    vault.trash("notes/003-moved.md").expect("trash");
    let bucket = vault.buckets().expect("buckets")[0].name.clone();
    vault.restore(&bucket).expect("restore");
    vault
        .write_config(r#"{"checkpoints":true}"#)
        .expect("config");

    let written = vault.written();
    assert_eq!(
        checkpoint(tmp.path(), "14:07Z", &written),
        Checkpoint::Committed
    );
    let message = last_message(&tmp);
    assert!(
        !message.contains("Outside:") && !message.contains("Both:"),
        "the app's own housekeeping was attributed to somebody else:\n{message}"
    );
    assert!(message.contains("\nYou: notes/003-a.md\n"), "{message}");
    assert!(message.contains("\nYou: notes/003-moved.md\n"), "{message}");
    assert!(
        message.contains("\nYou: .register/config.json\n"),
        "{message}"
    );
}

// ------------------------------------------------------------- the driver

/// Push one event through the checkpointer and wait for the quiet to expire.
async fn drive(tmp: &TempVault, idle: Duration) {
    let vault = Arc::new(tmp.open());
    let (events, _keep) = tokio::sync::broadcast::channel(16);
    let _checkpointer = Checkpointer::with_idle(vault, events.subscribe(), idle);

    let _ = events.send(crate::watch::Event {
        change: crate::watch::Change::Changed,
        path: "notes/004-b.md".to_owned(),
        etag: None,
    });
    // Long enough for the idle to expire and the blocking commit to finish.
    tokio::time::sleep(idle + Duration::from_millis(600)).await;
}

#[tokio::test]
async fn the_driver_commits_after_the_vault_goes_quiet() {
    let tmp = TempVault::new();
    repo(&tmp);
    // Through the vault, which creates `.register/` — a vault made by hand has
    // no app directory until something writes to it.
    tmp.open()
        .write_config(r#"{"checkpoints":true}"#)
        .expect("write config");
    tmp.put("notes/004-b.md", "---\nref: 004\n---\nWritten since.\n");

    drive(&tmp, Duration::from_millis(150)).await;

    assert!(
        log(&tmp).contains("checkpoint:"),
        "no checkpoint was taken:\n{}",
        log(&tmp)
    );
}

#[tokio::test]
async fn the_driver_does_nothing_unless_the_vault_asks() {
    // Off by default, and the default is what a vault has until it says so.
    let tmp = TempVault::new();
    repo(&tmp);
    tmp.put("notes/004-b.md", "---\nref: 004\n---\nWritten since.\n");
    let before = log(&tmp);

    drive(&tmp, Duration::from_millis(150)).await;

    assert_eq!(log(&tmp), before, "it committed without being asked");
    assert!(!status(tmp.path()).expect("status").clean);
}

#[tokio::test]
async fn a_busy_vault_is_not_committed_mid_sentence() {
    // The debounce: events keep arriving, so the deadline keeps moving and the
    // session becomes one commit at the end rather than forty along the way.
    let tmp = TempVault::new();
    repo(&tmp);
    // Through the vault, which creates `.register/` — a vault made by hand has
    // no app directory until something writes to it.
    tmp.open()
        .write_config(r#"{"checkpoints":true}"#)
        .expect("write config");

    let vault = Arc::new(tmp.open());
    let (events, _keep) = tokio::sync::broadcast::channel(16);
    let _checkpointer =
        Checkpointer::with_idle(vault, events.subscribe(), Duration::from_millis(300));

    for nth in 0..5 {
        tmp.put(
            &format!("notes/00{}-x.md", nth + 4),
            "---\nref: 004\n---\nx\n",
        );
        let _ = events.send(crate::watch::Event {
            change: crate::watch::Change::Changed,
            path: format!("notes/00{}-x.md", nth + 4),
            etag: None,
        });
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    // Still inside the quiet period after the last one.
    assert!(!log(&tmp).contains("checkpoint:"), "committed too early");

    tokio::time::sleep(Duration::from_millis(700)).await;
    let history = log(&tmp);
    assert_eq!(
        history.matches("checkpoint:").count(),
        1,
        "a writing session should be one commit:\n{history}"
    );
}

/// A repository's config is code, and a vault can arrive from anywhere.
///
/// `core.fsmonitor` was a working unauthenticated RCE: it runs on `git status`,
/// `/api/tree` calls `status` on every request, and the UI calls `/api/tree` on
/// load — so `register serve ./someone-elses-vault` and opening the page was
/// arbitrary code execution, on the default loopback bind with no token.
///
/// `filter.*.clean` is the same class (it runs on `status` too, normalising the
/// worktree to decide what changed), and a `post-commit` hook is the third:
/// `--no-verify` skips pre-commit and commit-msg but never post-commit.
///
/// Each marker file below is written by a payload this test plants. None of them
/// may exist afterwards.
#[test]
fn a_hostile_repository_config_does_not_execute() {
    let tmp = TempVault::new();
    repo(&tmp);

    let spoil = tmp.path().join("spoil");
    fs::create_dir_all(&spoil).expect("mkdir");
    let marker = |name: &str| spoil.join(name);
    let touch = |name: &str| format!("touch {}", marker(name).display());

    let set = |key: &str, value: &str| {
        Command::new("git")
            .arg("-C")
            .arg(tmp.path())
            .args(["config", key, value])
            .output()
            .expect("git config");
    };
    set("core.fsmonitor", &format!("{}; false", touch("fsmonitor")));
    set("filter.evil.clean", &format!("{}; cat", touch("filter")));
    set("core.pager", &touch("pager"));
    fs::write(tmp.path().join(".gitattributes"), "* filter=evil\n").expect("attributes");

    let hooks = tmp.path().join(".git/hooks");
    fs::create_dir_all(&hooks).expect("mkdir hooks");
    let hook = hooks.join("post-commit");
    fs::write(&hook, format!("#!/bin/sh\n{}\n", touch("hook"))).expect("hook");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    // Everything that touches git: the status path /api/tree runs on every
    // request, and the checkpoint path that `add`s and `commit`s.
    let _ = is_repo(tmp.path());
    let _ = status(tmp.path());
    tmp.put("notes/004-b.md", "---\nref: 004\n---\nMore.\n");
    let _ = checkpoint(tmp.path(), "00:00Z", &Written::new());

    for name in ["fsmonitor", "filter", "pager", "hook"] {
        assert!(
            !marker(name).exists(),
            "the repository's own config executed `{name}` — a vault you were \
             given is arbitrary code execution"
        );
    }

    // And the disarming did not simply break git: status still answers.
    assert!(
        status(tmp.path()).is_some(),
        "hardening broke the status path it was protecting"
    );
}

#[test]
fn the_marks_count_each_column_of_git_status_short() {
    // The format is two columns then the path: X is index-against-HEAD, Y is
    // worktree-against-index. Written out rather than generated, because the
    // whole risk here is misreading a column.
    let porcelain = concat!(
        "M  staged-only.md\n",   // index moved, worktree matches it
        " M worktree-only.md\n", // worktree moved, nothing staged
        "MM both.md\n",          // staged, then edited again
        "A  added.md\n",
        "?? untracked.md\n",
        "R  old.md -> new.md\n",
    );

    // both.md counts once in each column, which is what makes the marks add up
    // to what `git status --short` prints.
    assert_eq!(tally(porcelain), (4, 2, 1));
}

#[test]
fn a_leading_space_is_a_status_column_and_not_padding() {
    // Trimming the line first turns " M" (worktree-modified) into "M "
    // (staged) — the whole file would report the wrong column.
    assert_eq!(tally(" M a.md\n"), (0, 1, 0));
    assert_eq!(tally("M  a.md\n"), (1, 0, 0));
}

#[test]
fn nothing_uncommitted_is_no_marks_at_all() {
    assert_eq!(tally(""), (0, 0, 0));
    assert_eq!(tally("\n"), (0, 0, 0));
}

#[test]
fn a_state_nobody_enumerated_still_counts() {
    // Unmerged paths carry U in both columns. A whitelist of the letters we
    // expected would drop them and report a clean-looking branch for a vault
    // mid-conflict.
    assert_eq!(tally("UU conflicted.md\n"), (1, 1, 0));
    assert_eq!(tally("C  copied.md\n"), (1, 0, 0));
}

#[test]
fn the_status_names_the_branch_and_counts_what_changed() {
    let tmp = TempVault::new();
    repo(&tmp);

    let clean = status(tmp.path()).expect("status");
    assert_eq!(clean.branch.as_deref(), Some("main"));
    assert!(clean.clean);
    assert_eq!((clean.staged, clean.modified, clean.untracked), (0, 0, 0));

    tmp.put("notes/009-new.md", "---\nref: 009\n---\nUntracked.\n");
    let dirty = status(tmp.path()).expect("status");
    assert!(!dirty.clean);
    assert_eq!(dirty.untracked, 1);
    assert_eq!((dirty.staged, dirty.modified), (0, 0));
    // The branch does not change just because the tree did.
    assert_eq!(dirty.branch.as_deref(), Some("main"));
}

#[test]
fn a_detached_head_has_no_branch_to_name() {
    // `rev-parse --abbrev-ref HEAD` answers "HEAD" here — a branch name that
    // looks real and is not one. `symbolic-ref` fails instead, which is what
    // `None` records.
    let tmp = TempVault::new();
    repo(&tmp);
    let head = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(tmp.path())
        .output()
        .expect("rev-parse");
    let sha = String::from_utf8_lossy(&head.stdout).trim().to_owned();
    assert!(
        Command::new("git")
            .args(["checkout", "--detach", &sha])
            .current_dir(tmp.path())
            .output()
            .expect("checkout")
            .status
            .success()
    );

    let detached = status(tmp.path()).expect("status");
    assert_eq!(detached.branch, None);
    assert!(detached.clean, "detaching changed no file");
}

#[test]
fn a_checkpoint_stands_aside_when_something_is_staged() {
    // `add -A` sweeps whatever you staged with `git add -p` into the app's
    // commit, which destroys work you were composing — and a checkpoint is the
    // app's bookkeeping, so it has no business deciding your next commit.
    let tmp = TempVault::new();
    repo(&tmp);
    tmp.put("notes/004-b.md", "---\nref: 004\n---\nsomething\n");

    // You stage a hunk.
    let staged = std::process::Command::new("git")
        .args(["add", "notes/004-b.md"])
        .current_dir(tmp.path())
        .status()
        .expect("git add");
    assert!(staged.success());

    match checkpoint(tmp.path(), "2026-08-17T10:00:00Z", &Written::new()) {
        Checkpoint::Refused(why) => {
            assert!(
                why.contains("staged"),
                "the refusal does not say why: {why}"
            );
        }
        other => panic!("expected the checkpoint to stand aside, got {other:?}"),
    }

    // And it wrote nothing: the hunk is still yours to commit.
    let log = std::process::Command::new("git")
        .args(["log", "--oneline"])
        .current_dir(tmp.path())
        .output()
        .expect("git log");
    let history = String::from_utf8_lossy(&log.stdout);
    assert!(
        !history.contains("checkpoint:"),
        "a checkpoint committed over a staged index: {history}"
    );
}

#[test]
fn an_untracked_note_is_not_a_staged_one() {
    // `??` is the ordinary state of a vault being written in. Reading it as
    // "something is staged" would stand every checkpoint down forever, which is
    // the failure mode this rule invites.
    let tmp = TempVault::new();
    repo(&tmp);
    tmp.put(
        "notes/004-b.md",
        "---\nref: 004\n---\nwritten, never staged\n",
    );

    assert_eq!(
        checkpoint(tmp.path(), "2026-08-17T10:00:00Z", &Written::new()),
        Checkpoint::Committed,
        "an untracked note should still be checkpointed"
    );
}
