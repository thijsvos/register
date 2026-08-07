//! Release engineering, as assertions (§08 P10, §06 rule 11, §07).
//!
//! None of this can be checked by running the thing: a Dockerfile is proven by
//! Docker and a workflow by GitHub, and both take a tag push and a network. What
//! *can* be checked here is the part that rots silently — a version pinned in
//! two places and bumped in one, a floating tag creeping into a build, a target
//! quietly dropped from the release matrix.
//!
//! §06 states the rule these enforce: "each version lives in exactly one file,
//! everything else references it."

use std::fs;

fn read(path: &str) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

/// The lines that reach a builder. Prose has to stay free to name the versions
/// and the tags it is explaining, or the only way to document a rule is to
/// break it.
fn strip_comments(text: &str) -> String {
    text.lines()
        .map(|line| line.split('#').next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

// -------------------------------------------------------------- the container

#[test]
fn the_image_pins_the_same_toolchains_the_repo_does() {
    let dockerfile = read("deploy/Dockerfile");

    // .nvmrc is the single source of truth for Node (§06 manifest).
    let node = read(".nvmrc").trim().to_owned();
    assert!(
        dockerfile.contains(&format!("FROM node:{node}-alpine")),
        "Dockerfile's node image does not match .nvmrc ({node})"
    );

    // rust-toolchain.toml is the single source of truth for Rust. The image tag
    // may be less precise than the channel — 1.97-alpine tracks 1.97.1 — but it
    // must not name a different minor.
    let toolchain = read("rust-toolchain.toml");
    let channel = toolchain
        .lines()
        .find_map(|line| line.split_once("channel = "))
        .map(|(_, value)| value.trim().trim_matches('"').to_owned())
        .expect("channel in rust-toolchain.toml");
    let tag = dockerfile
        .split_once("FROM rust:")
        .and_then(|(_, rest)| rest.split_once("-alpine"))
        .map(|(tag, _)| tag.to_owned())
        .expect("a rust image tag in the Dockerfile");
    assert!(
        channel.starts_with(&tag),
        "Dockerfile pins rust {tag}, rust-toolchain.toml pins {channel}"
    );
}

#[test]
fn the_image_takes_pnpm_from_the_manifest_rather_than_restating_it() {
    // §07's listing says `pnpm@10`; this repo pins 11.20.0 in packageManager,
    // and a hardcoded 10 cannot read the lockfile. The fix is not to correct the
    // number — it is to have only one of them.
    let dockerfile = read("deploy/Dockerfile");
    assert!(
        dockerfile.contains("packageManager"),
        "the Dockerfile should derive pnpm from app/package.json"
    );
    // Comments only, stripped: the comment above that line has to be free to
    // name the version it is explaining away.
    let code = strip_comments(&dockerfile);
    assert!(
        !code.contains("pnpm@10") && !code.contains("pnpm@11"),
        "the Dockerfile hardcodes a pnpm version; packageManager is the pin"
    );
}

#[test]
fn the_image_is_scratch_and_serves_the_vault_it_is_given() {
    let dockerfile = read("deploy/Dockerfile");
    // §07: "3-stage → scratch, image ≈ binary size".
    assert_eq!(dockerfile.matches("FROM ").count(), 3, "§07 wants 3 stages");
    assert!(dockerfile.contains("FROM scratch"));
    assert!(dockerfile.contains("EXPOSE 7777"));
    assert!(dockerfile.contains(r#"ENTRYPOINT ["/register","serve","/vault""#));
    // The lockfile governs, exactly as it does in CI.
    assert!(dockerfile.contains("--locked"));
    assert!(dockerfile.contains("--frozen-lockfile"));
}

#[test]
fn the_build_context_carries_no_licensed_font_bytes() {
    // §03: a licensed face is the user's property. A build context is a copy of
    // whatever it can see, and images get pushed to registries.
    let ignore = read(".dockerignore");
    assert!(ignore.contains(".register"), "{ignore}");
    assert!(ignore.contains("/target/"), "{ignore}");
    assert!(ignore.contains("node_modules"), "{ignore}");
}

#[test]
fn ci_greps_for_stray_fonts() {
    // §03's last line and CLAUDE.md rule 7 both promise this grep, and
    // CONTRIBUTING.md tells contributors a licensed face cannot be committed.
    // For a while all three were true only as prose: `doctrine.test.ts` globs
    // `../public/fonts/**`, so it polices the sanctioned directory and is blind
    // to a face committed anywhere else. This pins the step that closed it.
    let ci = strip_comments(&read(".github/workflows/ci.yml"));
    assert!(
        ci.contains("git ls-files"),
        "the font job no longer reads what is tracked"
    );
    assert!(
        ci.contains("app/public/fonts/"),
        "the font job no longer names the one sanctioned directory"
    );
    for face in ["berkeley", "tx-?02"] {
        assert!(
            ci.contains(face),
            "the font job stopped naming `{face}`, which §03 bans outright"
        );
    }
}

#[test]
fn compose_mounts_a_vault_and_publishes_one_port() {
    let compose = read("deploy/docker-compose.yml");
    assert!(compose.contains("${VAULT_PATH:-./vault}:/vault"));
    assert!(compose.contains(r#""7777:7777""#));
    assert!(compose.contains("dockerfile: deploy/Dockerfile"));
}

// ---------------------------------------------------------------- the release

#[test]
fn every_platform_08_p10_names_is_built() {
    let release = read(".github/workflows/release.yml");
    for target in [
        "aarch64-apple-darwin",
        "x86_64-apple-darwin",
        "x86_64-unknown-linux-musl",
        "aarch64-unknown-linux-musl",
        "x86_64-pc-windows-msvc",
    ] {
        assert!(release.contains(target), "release.yml is missing {target}");
    }
    assert!(release.contains("tags: [\"v*\"]"), "should fire on v* tags");
    assert!(release.contains("ghcr.io/$OWNER/register"), "no ghcr push");
}

#[test]
fn a_release_binary_over_the_budget_fails_the_build() {
    // §06: "Release binary ≤ 10 MB". Locally this repo builds to about 3 MB, so
    // the check exists for the day something is linked in that should not be.
    let release = read(".github/workflows/release.yml");
    assert!(
        release.contains("10 * 1024 * 1024"),
        "release.yml has no 10 MB check"
    );
    assert!(
        release.contains("test \"$BYTES\" -le \"$LIMIT\""),
        "the 10 MB check does not fail the step"
    );
}

#[test]
fn nothing_consumes_a_tag_that_moves() {
    // Rule 11 bans `latest` as an image or package version in Dockerfiles,
    // workflows and manifests. Runner labels are exempt — they name
    // GitHub-managed infrastructure, no update bot tracks them, and pinning one
    // would create a stale pin nothing owns.
    let exempt = ["ubuntu-latest", "macos-latest", "windows-latest"];

    for path in [
        "deploy/Dockerfile",
        "deploy/docker-compose.yml",
        ".github/workflows/ci.yml",
        ".github/workflows/release.yml",
    ] {
        for (nth, line) in strip_comments(&read(path)).lines().enumerate() {
            let mut rest = line.to_owned();
            for label in exempt {
                rest = rest.replace(label, "");
            }
            assert!(
                !rest.contains("latest"),
                "{path}:{} consumes a floating tag: {line}",
                nth + 1
            );
        }
    }
}

#[test]
fn ci_runs_the_same_gates_a_phase_is_judged_by() {
    // CLAUDE.md rule 10 lists them. A CI that runs a weaker set is a CI that
    // reports green for a phase that is not done.
    let ci = read(".github/workflows/ci.yml");
    for gate in [
        "cargo fmt --check",
        "cargo clippy --locked --all-targets -- -D warnings",
        "cargo test --locked",
        "pnpm check",
        "pnpm test",
        "pnpm build",
        "pnpm size",
    ] {
        assert!(ci.contains(gate), "ci.yml does not run `{gate}`");
    }
    // `pnpm test -- --run` looks like it passes a flag and does not: pnpm
    // forwards the `--`, and the script has been plain `vitest run` since P1.
    assert!(!ci.contains("pnpm test --"), "stale flag in the test step");
}

#[test]
fn the_documented_compose_command_rebuilds() {
    // `docker compose up` silently reuses the last image it built, so a change
    // you just made is absent and the symptom is indistinguishable from the
    // code not working. Documenting the form that does not rebuild is worse
    // than documenting nothing.
    let readme = read("README.md");
    let compose_lines: Vec<&str> = readme
        .lines()
        .filter(|line| line.contains("docker compose") && line.contains("up"))
        .collect();

    assert!(
        !compose_lines.is_empty(),
        "the README stopped documenting it"
    );
    for line in compose_lines {
        assert!(
            line.contains("--build"),
            "the README teaches a compose command that reuses a stale image: {line}"
        );
    }
}
