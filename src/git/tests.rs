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
    assert_eq!(checkpoint(tmp.path(), "14:07Z"), Checkpoint::Nothing);
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
    assert_eq!(checkpoint(&inner, "14:07Z"), Checkpoint::Nothing);
}

#[test]
fn a_checkpoint_commits_everything_and_says_when() {
    let tmp = TempVault::new();
    repo(&tmp);
    tmp.put("notes/004-b.md", "---\nref: 004\n---\nWritten since.\n");

    assert!(!status(tmp.path()).expect("status").clean);
    assert_eq!(checkpoint(tmp.path(), "14:07Z"), Checkpoint::Committed);

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

    assert_eq!(checkpoint(tmp.path(), "14:07Z"), Checkpoint::Nothing);
    assert_eq!(log(&tmp), before);
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

    match checkpoint(tmp.path(), "14:07Z") {
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

    assert_eq!(checkpoint(tmp.path(), "14:07Z"), Checkpoint::Committed);
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
    assert_eq!(checkpoint(tmp.path(), "14:07Z"), Checkpoint::Committed);

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
    let _ = checkpoint(tmp.path(), "00:00Z");

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
