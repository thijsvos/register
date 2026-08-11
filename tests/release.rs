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
    // Both ends non-empty first. `"1.97.1".starts_with("")` is `true`, so a
    // Dockerfile line reading `FROM rust:-alpine` — or any future edit that
    // makes the split yield nothing — satisfied this comparison unconditionally.
    // An always-true assertion inside a test about version pinning.
    assert!(!tag.is_empty(), "no rust tag in the Dockerfile");
    assert!(!channel.is_empty(), "no channel in rust-toolchain.toml");
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
    // Comments stripped, for the reason `compose_mounts_a_vault_and_publishes_
    // one_port_on_loopback` gives 100 lines below — and this test is the proof
    // that writing it down once was not enough. It read the file raw, and
    // `deploy/Dockerfile:11` is a comment mentioning both `--locked` and
    // `--frozen-lockfile` while explaining why they are there. Measured: delete
    // both flags from the real lines and every assertion here still passed, so
    // the release image would resolve a dependency graph nobody tested — the
    // exact failure the next two lines exist to prevent.
    let dockerfile = strip_comments(&read("deploy/Dockerfile"));

    // §07: "3-stage → scratch, image ≈ binary size". Still three stages, and the
    // *published* image is still the scratch one — that half is asserted in
    // `only_the_developed_image_carries_git`, which also says why this half is
    // not: the GIT field is derived by shelling out to git, and `scratch` has no
    // git, so the field could only ever draw `—` here.
    assert_eq!(dockerfile.matches("FROM ").count(), 3, "§07 wants 3 stages");
    assert!(
        dockerfile.contains("FROM alpine:3."),
        "the runtime stage should be a pinned Alpine release, not scratch and \
         not a floating tag"
    );
    // Nothing from the build stages comes with it: the runtime carries the
    // binary and git, never a compiler or a package index.
    assert!(
        !dockerfile.contains("FROM rust:1.97-alpine\nRUN apk add --no-cache git"),
        "the runtime stage must be its own stage, not a layer on the builder"
    );
    assert!(dockerfile.contains("EXPOSE 7777"));
    assert!(dockerfile.contains(r#"ENTRYPOINT ["/register","serve","/vault""#));
    // The lockfile governs, exactly as it does in CI.
    assert!(dockerfile.contains("--locked"));
    assert!(dockerfile.contains("--frozen-lockfile"));

    // A positive control on the stripping itself: prose that names these flags
    // is still in the file, so if `strip_comments` ever became a no-op the
    // assertions above would silently go back to reading comments.
    let raw = read("deploy/Dockerfile");
    assert!(
        raw.lines().any(|line| line.trim_start().starts_with('#')
            && (line.contains("--locked") || line.contains("--frozen-lockfile"))),
        "the comment that made this test vacuous is gone; if the flags are now \
         only in code, this control is no longer measuring anything"
    );
}

/// Two Dockerfiles, one runtime contract.
///
/// `deploy/Dockerfile` builds from source — it is what `docker compose up
/// --build` and every developer uses. `deploy/Dockerfile.release` compiles
/// nothing and `COPY`s the binaries the matrix already cross-built, which is the
/// only way to publish arm64 without a Rust release build under QEMU.
///
/// The cost of two files is that they can disagree, and the half nobody develops
/// against is the half that ships. So the runtime stanza — who the process runs
/// as, what it exposes, what it is told to do — is compared line for line rather
/// than asserted twice.
#[test]
fn the_published_image_runs_exactly_what_the_developed_one_does() {
    let dev = strip_comments(&read("deploy/Dockerfile"));
    let release = strip_comments(&read("deploy/Dockerfile.release"));

    // Every directive that survives into the final stage. A `USER` that drifted
    // to root, or an ENTRYPOINT missing --allow-tokenless-network, would be a
    // published image behaving unlike the one anyone tested.
    for directive in ["USER ", "VOLUME ", "EXPOSE ", "ENTRYPOINT "] {
        let from_dev = line_starting(&dev, directive);
        let from_release = line_starting(&release, directive);
        assert_eq!(
            from_dev, from_release,
            "{directive}drifted between deploy/Dockerfile and deploy/Dockerfile.release"
        );
    }

    // One stage: it compiles nothing of ours. The Rust build stays in the
    // `binaries` matrix on native runners, which is what keeps a release from
    // ever compiling under emulation.
    assert_eq!(
        release.matches("FROM ").count(),
        1,
        "the release image should be one stage — it compiles nothing"
    );
    // The same runtime base as the developed image. These were `scratch` and
    // Alpine for one commit, which made the GIT field derivable in the image
    // people build and not in the one they pull.
    // The LAST `FROM`, not the first: the developed image has three stages and
    // its first is the UI builder. `line_starting` takes the first match — its
    // doc comment claimed otherwise, which is corrected below.
    let base = |text: &str| last_starting(text, "FROM ");
    assert_eq!(
        base(&dev),
        base(&release),
        "the two images no longer start from the same base"
    );
    // The binary comes from the matrix, named for the platform buildx asks for.
    assert!(
        release.contains("COPY dist/register-linux-${TARGETARCH} /register"),
        "the release image should copy the cross-built binary for its platform"
    );
    assert!(
        release.contains("ARG TARGETARCH"),
        "TARGETARCH has to be declared or the COPY silently resolves to nothing"
    );
}

/// Both images carry git, and that is load-bearing rather than incidental.
///
/// The status bar's GIT field is derived by shelling out to `git`, so a
/// `scratch` runtime can only ever draw `—` whatever the repository is doing.
/// The developed image gained git first; the published one followed, because
/// pulling it is now the documented way in and the newcomer's field was the one
/// that dashed.
///
/// The cost is one `RUN` executing per target architecture, so release.yml
/// installs binfmt. That is asserted here too: drop the QEMU step and the arm64
/// half of `apk add` has no interpreter, which fails at publish time — the
/// slowest possible place to find out.
#[test]
fn both_images_carry_git_and_the_release_can_emulate() {
    let dev = strip_comments(&read("deploy/Dockerfile"));
    let release = strip_comments(&read("deploy/Dockerfile.release"));

    assert!(
        dev.contains("apk add --no-cache git"),
        "the developed image needs git or the GIT field is permanently dashed"
    );
    // Scoped to the mount, not `*`: this trusts exactly the directory the
    // operator already chose to hand us.
    //
    // It guards the Linux case — a real bind mount keeps its real owner, so a
    // container uid that does not match it gets "detected dubious ownership" and
    // the GIT field silently goes back to `—`. Not reproducible on Docker
    // Desktop, whose file sharing reports the mount as owned by whichever uid
    // asks (measured: uid 1000 sees 1000:0 and uid 501 sees 501:0 for the same
    // path), which is exactly why it is pinned by a test rather than left to be
    // noticed — nobody developing on a Mac can trip it.
    assert!(
        dev.contains("GIT_CONFIG_VALUE_0=/vault"),
        "git refuses a bind-mounted repo it does not own without safe.directory"
    );

    assert!(
        release.contains("apk add --no-cache git"),
        "the published image needs git or the GIT field dashes for everyone who \
         pulls it, which is now the documented way in"
    );
    assert!(
        release.contains("GIT_CONFIG_VALUE_0=/vault"),
        "the published image needs safe.directory for the same reason the \
         developed one does"
    );

    // The `RUN` above executes on each target architecture, so the workflow has
    // to install binfmt before building. Asserted together with the RUN itself:
    // either both are there or neither is, and a release that publishes the
    // arm64 half of an emulated build without an emulator fails at push time.
    let workflow = strip_comments(&read(".github/workflows/release.yml"));
    assert!(
        workflow.contains("docker/setup-qemu-action"),
        "the release image RUNs on a foreign architecture with no binfmt \
         installed; arm64 will fail at `apk add`"
    );
    assert!(
        workflow.contains("--platform linux/amd64,linux/arm64"),
        "the QEMU step only earns its place if both platforms are built"
    );
}

/// The **first** line beginning with `prefix`, trimmed — panics if there is
/// none, so a directive that vanished fails loudly rather than comparing None to
/// None.
///
/// The directives this is used for appear once per file. For `FROM`, which does
/// not, use `last_starting`.
fn line_starting(text: &str, prefix: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| line.starts_with(prefix))
        .unwrap_or_else(|| panic!("no line starting with {prefix:?}"))
        .to_owned()
}

/// The last line beginning with `prefix`, trimmed. The runtime stage of a
/// multi-stage Dockerfile is its final `FROM`, and comparing the first would
/// compare the developed image's UI builder against the published image's
/// runtime — two different things that happen to share a keyword.
fn last_starting(text: &str, prefix: &str) -> String {
    text.lines()
        .map(str::trim)
        .rfind(|line| line.starts_with(prefix))
        .unwrap_or_else(|| panic!("no line starting with {prefix:?}"))
        .to_owned()
}

/// §07's remote pattern is a home server behind Tailscale, which is as likely to
/// be an arm64 Pi as an x86 box — and every Apple Silicon machine is arm64.
/// Publishing amd64 alone was a roadmap entry for exactly that reason.
#[test]
fn the_image_is_published_for_both_architectures() {
    let release = strip_comments(&read(".github/workflows/release.yml"));

    assert!(
        release.contains("--platform linux/amd64,linux/arm64"),
        "the container job should publish a multi-platform manifest"
    );
    assert!(
        release.contains("-f deploy/Dockerfile.release"),
        "the container job should build the prebuilt-binary Dockerfile"
    );
    // buildx cannot load a multi-platform image into the daemon, so the push has
    // to happen as part of the build. A later `docker push` would push nothing.
    assert!(
        release.contains("--push"),
        "a multi-platform build has to push from the builder"
    );
    // Both binaries have to be staged under the names TARGETARCH resolves to.
    assert!(
        release.contains("mv dist/register-linux-x64 dist/register-linux-amd64"),
        "the x64 artifact must be renamed to the platform buildx asks for"
    );
    assert!(
        release.contains("test -f dist/register-linux-arm64"),
        "the arm64 artifact must be present, not assumed"
    );
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
fn the_cross_targets_land_in_the_toolchain_that_does_the_building() {
    // Three of the five release legs cross-compile, and this is the seam they
    // fell through. `dtolnay/rust-toolchain@stable` installs the toolchain it
    // names; rust-toolchain.toml pins a channel, and a pin beats a default — so
    // `with: { targets: … }` put the cross std in `stable` while cargo ran under
    // the pin, a different directory that had never seen it. Every such leg died
    // on E0463 before compiling a line.
    //
    // `rustup target add` as a step, with no `+toolchain`, resolves the active
    // toolchain the same way cargo does. That is the property worth holding: not
    // which toolchain, but that the build and whatever installs its std can only
    // ever agree.
    let code = strip_comments(&read(".github/workflows/release.yml"));

    assert!(
        !code.contains("targets:"),
        "release.yml hands `targets:` to the toolchain action, which installs \
         them into the toolchain the action names rather than the one \
         rust-toolchain.toml pins"
    );
    assert!(
        code.contains("rustup target add ${{ matrix.target }}"),
        "nothing adds the cross target to the toolchain cargo will run under"
    );

    // And the fix must not quietly become a second copy of the pin (rule 11):
    // the step names a matrix target, never a channel.
    let channel = read("rust-toolchain.toml")
        .lines()
        .find_map(|line| line.split_once("channel = "))
        .map(|(_, value)| value.trim().trim_matches('"').to_owned())
        .expect("channel in rust-toolchain.toml");
    if channel.starts_with(|c: char| c.is_ascii_digit()) {
        assert!(
            !code.contains(&channel),
            "release.yml names the {channel} pin; rust-toolchain.toml is the one copy"
        );
    }
}

#[test]
fn a_tag_still_runs_the_gates() {
    // release.yml says the gates "run alongside this rather than being restated
    // here", which is only true while a tag push reaches ci.yml. That was free
    // under a bare `push:`; adding a `branches:` filter to cut duplicate runs
    // silently took it away, and would have cut a release with nothing checking
    // it. The comment is load-bearing, so it gets a test.
    // The two patterns compared, not merely `contains("tags:")` — that is
    // satisfied by `tags: []`, which runs on nothing, and by a pattern that has
    // drifted from the one release.yml fires on. What matters is that every tag
    // starting a release also starts the gates.
    let pattern = |path: &str| {
        strip_comments(&read(path))
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix("tags:")
                    .map(str::trim)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| panic!("{path} has no `tags:` in its push trigger"))
    };
    let ci = pattern(".github/workflows/ci.yml");
    let release = pattern(".github/workflows/release.yml");

    assert!(
        !ci.is_empty() && ci != "[]",
        "ci.yml's tag filter matches nothing: {ci}"
    );
    assert_eq!(
        ci, release,
        "ci.yml fires on {ci} and release.yml on {release}, so some tag cuts a \
         release with nothing checking it"
    );
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
    for face in ["berkeley", "tx-?02"] {
        assert!(
            ci.contains(face),
            "the font job stopped naming `{face}`, which §03 bans outright"
        );
    }

    // The extension alternation, by name. This is the pattern the job's own
    // anti-vacuity guard was written against after it proved a *narrower* one
    // — and nothing here checked it, so narrowing it back to `\.woff2$` would
    // have let a .otf through with both layers green.
    assert!(
        ci.contains(r"\.(woff2?|ttf|otf|eot)$"),
        "the font job's extension pattern changed; a stray .otf may now pass"
    );

    // `app/public/fonts/` appears twice — once in the real `grep -v` exclusion
    // and once in the job's own proof line — so a bare `contains` survives
    // deleting the entire check. Require the exclusion specifically.
    assert!(
        ci.contains("grep -v '^app/public/fonts/'"),
        "nothing excludes the sanctioned directory, so every vendored face \
         now reads as a stray — or the check is gone"
    );

    // And that finding one is fatal. Without this, turning both `exit 1`s into
    // `echo` leaves the job reporting success on a repo with a licensed face
    // committed, which is the only outcome §03 actually cares about.
    assert_eq!(
        ci.matches("exit 1").count(),
        2,
        "the font job no longer fails when it finds something"
    );
}

#[test]
fn compose_mounts_a_vault_and_publishes_one_port_on_loopback() {
    // Comments stripped first, and that is the point rather than tidiness. This
    // test used to read the raw file and look for `"7777:7777"`; when the port
    // moved to `"127.0.0.1:7777:7777"` that substring survived only in a comment
    // showing the old form, so the assertion went on passing while testing
    // nothing. A test satisfied by a comment is worse than no test.
    let compose = strip_comments(&read("deploy/docker-compose.yml"));

    // Required, with no default. `${VAULT_PATH:-./vault}` resolved against the
    // compose file, so forgetting it put a real vault inside the checkout —
    // there is a .gitignore entry for that path, which is how we know it
    // happened. `:?` makes compose refuse to start and say what to set.
    assert!(
        compose.contains("${VAULT_PATH:?"),
        "VAULT_PATH has a default again, so an unset one lands somewhere quietly:\n{compose}"
    );
    assert!(
        !compose.contains("${VAULT_PATH:-"),
        "VAULT_PATH must not have a fallback path"
    );
    // A bind mount, never a named volume: §04's premise is a folder you can open
    // in a terminal and put under git.
    assert!(compose.contains(":/vault"));

    // The default path pulls. A `build:` here is what made the only documented
    // way in "clone it and compile", which is exactly the barrier this split
    // removed — so its absence is the assertion, not its presence.
    assert!(
        !compose.contains("build:"),
        "the default compose builds again; the build belongs in the overlay"
    );
    assert!(
        compose.contains("image: ghcr.io/"),
        "the default compose no longer names a published image"
    );

    // And the overlay still exists, still builds, and does not masquerade as the
    // published tag.
    let overlay = strip_comments(&read("deploy/docker-compose.build.yml"));
    assert!(overlay.contains("dockerfile: deploy/Dockerfile"));
    assert!(
        overlay.contains("image: register:source"),
        "a local build tagged as the published image would shadow it in the \
         image store, and `docker pull` would skip a version you do not have"
    );

    assert!(
        compose.contains(r#""127.0.0.1:7777:7777""#),
        "compose no longer publishes on loopback only:\n{compose}"
    );
    // The negative is what survives a rename: any published port whose host part
    // is absent or wildcard reaches every interface on the machine.
    assert!(
        !compose.contains(r#""7777:7777""#) && !compose.contains(r#""0.0.0.0:"#),
        "compose publishes on every interface:\n{compose}"
    );
    // Root in the container writes root-owned notes into the host's vault.
    assert!(
        compose.contains("user:"),
        "compose no longer pins the uid the server writes as:\n{compose}"
    );
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
    // Narrower than `v*` on purpose: that also matches `vault-experiment` and
    // `v2-spike`, and `git push --tags` sends every local tag at once — one
    // stray name would cut a release of whatever it pointed at.
    assert!(
        release.contains("tags: [\"v[0-9]*\"]"),
        "release should fire on version tags, and only those"
    );
    assert!(release.contains("ghcr.io/$OWNER/register"), "no ghcr push");

    // The publish job refuses to release unless it has one asset per target,
    // and that count is a literal. Tie it to the matrix here, so adding a sixth
    // target fails in the pull request rather than after six release builds
    // have run and the image has already been pushed.
    let targets = release.matches("- os:").count();
    assert_eq!(targets, 5, "the release matrix changed size");
    assert!(
        release.contains(&format!("wc -l)\" -eq {targets}")),
        "publish counts a different number of assets than the matrix builds"
    );
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

/// The compose file names a version, so a release that forgets it hands every
/// new user the previous build while the README says otherwise.
///
/// This is the drift rule 11 exists to catch, one file over: the quickstart is
/// the most-read thing in the repository and the least likely to be re-run by
/// the person cutting a release.
#[test]
fn the_quickstart_pulls_the_version_this_repo_is() {
    let manifest = read("Cargo.toml");
    let version = manifest
        .lines()
        .find_map(|line| line.strip_prefix("version = "))
        .map(|value| value.trim().trim_matches('"').to_owned())
        .expect("a version in Cargo.toml");
    assert!(!version.is_empty(), "no version in Cargo.toml");

    let compose = strip_comments(&read("deploy/docker-compose.yml"));
    let wanted = format!("register:v{version}");
    assert!(
        compose.contains(&wanted),
        "deploy/docker-compose.yml does not pull {wanted}:\n{compose}"
    );
}

#[test]
fn nothing_consumes_a_tag_that_moves() {
    // Rule 11 bans `latest` as an image or package version in Dockerfiles,
    // workflows and manifests. Runner labels are exempt — they name
    // GitHub-managed infrastructure, no update bot tracks them, and pinning one
    // would create a stale pin nothing owns.
    //
    // The image we PUBLISH under that name is exempt too, and the distinction is
    // the whole point of the rule: consuming a tag that moves means a dependency
    // nobody pinned, while publishing one is a convenience offered to people who
    // should not need to find a version string to try the product. Written as
    // the exact string we push, so `FROM alpine:latest` in the same file still
    // fails.
    let exempt = [
        "ubuntu-latest",
        "macos-latest",
        "windows-latest",
        "register:latest",
    ];

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
    //
    // Per job, not per file, and comments stripped. Searching the whole text
    // meant a gate could be satisfied from anywhere: `pnpm build` appears in
    // both `ui` and `e2e`, so deleting it from `ui` — where the size budget
    // depends on it — left this assertion green on the `e2e` job's copy. Every
    // other gate was comment-satisfiable for the same reason.
    let ci = strip_comments(&read(".github/workflows/ci.yml"));

    for (job, gates) in [
        (
            "server",
            &[
                "cargo fmt --check",
                "cargo clippy --locked --all-targets -- -D warnings",
                "cargo test --locked",
            ][..],
        ),
        (
            "ui",
            &["pnpm check", "pnpm test", "pnpm build", "pnpm size"][..],
        ),
    ] {
        let block = job_block(&ci, job);
        for gate in gates {
            assert!(
                block.contains(gate),
                "the `{job}` job does not run `{gate}`"
            );
        }
    }

    // `pnpm test -- --run` looks like it passes a flag and does not: pnpm
    // forwards the `--`, and the script has been plain `vitest run` since P1.
    assert!(!ci.contains("pnpm test --"), "stale flag in the test step");
}

/// One job's steps, from `  <name>:` to the next key at the same indent.
///
/// A hand-rolled slice rather than a YAML parser: §04's dependency list has no
/// room for one, and what this needs is "the lines belonging to this job",
/// which two indent rules describe completely.
fn job_block(ci: &str, job: &str) -> String {
    let header = format!("  {job}:");
    let mut lines = ci.lines().skip_while(|line| !line.starts_with(&header));
    let first = lines.next().unwrap_or_else(|| panic!("no `{job}` job"));

    std::iter::once(first)
        .chain(lines.take_while(|line| {
            // Deeper than the job key, or blank. A new `  name:` ends the block.
            line.trim().is_empty() || line.starts_with("   ")
        }))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn the_documented_compose_command_rebuilds() {
    // `docker compose up` silently reuses the last image it built, so a change
    // you just made is absent and the symptom is indistinguishable from the
    // code not working. Documenting the form that does not rebuild is worse
    // than documenting nothing.
    //
    // That is true of the BUILD path only. The default file has no `build:` in
    // it, so `up` there pulls and `--build` would be a flag with nothing to do —
    // and the whole point of splitting the files was that the quickstart should
    // not mention building at all. So the rule is now conditional: a documented
    // command that names the overlay must rebuild, and one that does not must
    // not pretend to.
    // Shell line continuations joined first: the build command is written across
    // two lines, so reading them separately finds a `docker compose` line with
    // no `up` on it and an `up` line with no command — and the filter below
    // silently matched neither. A test that stops seeing the thing it guards
    // reports success.
    // Every place a reader could copy one from, not only the README. The install
    // detail moved to `docs/install.md` when the README was cut down, and a rule
    // about "the documented command" has to follow the documentation or it
    // quietly starts guarding an empty file.
    let documented = ["README.md", "docs/install.md"]
        .iter()
        .map(|file| read(file).replace("\\\n", " "))
        .collect::<Vec<_>>()
        .join("\n");
    let compose_lines: Vec<&str> = documented
        .lines()
        .map(str::trim)
        .filter(|line| line.contains("docker compose") && line.contains(" up"))
        .collect();

    assert!(
        !compose_lines.is_empty(),
        "nothing documents `docker compose up` any more"
    );

    let mut builds = 0;
    for line in &compose_lines {
        // The overlay is what makes a build possible, so it — and not the flag —
        // is what identifies a build command. Testing for either meant the
        // assertion below restated its own branch condition and could not fail:
        // dropping `--build` from the documented command survived, which is how
        // a tautology announces itself.
        if line.contains("docker-compose.build.yml") {
            builds += 1;
            assert!(
                line.contains("--build"),
                "documents a compose build that reuses a stale image: {line}"
            );
        } else {
            assert!(
                !line.contains("--build"),
                "a pull-only command carries --build, which has nothing to build: {line}"
            );
        }
    }
    assert!(
        builds > 0,
        "nothing documents how to build the container from source any more"
    );
}

#[test]
fn mutation_testing_reports_rather_than_gates() {
    // ADR-006. `cargo test` answers "did the code run"; this answers "if the
    // code were wrong, would anything fail" — and its first run found that
    // swapping `|` for `^` in `constant_time_eq` survived the whole suite,
    // which is a token bypass.
    let mutants = strip_comments(&read(".github/workflows/mutants.yml"));

    // Scheduled and manual, never on a pull request: a full run is tens of
    // minutes and most survivors are noise. A slow noisy gate gets disabled.
    assert!(mutants.contains("schedule:"), "no schedule");
    assert!(
        mutants.contains("workflow_dispatch:"),
        "cannot be run on demand"
    );
    assert!(
        !mutants.contains("pull_request"),
        "mutation testing must not gate a pull request (ADR-006)"
    );

    // Pinned, like every other tool this repo installs, and tracked by the
    // custom manager in renovate.json.
    assert!(
        mutants.contains("cargo install cargo-mutants --version"),
        "cargo-mutants is unpinned; the tool judging the suite would drift"
    );

    // The UI is built first. `allow_missing` means a server built without it
    // still compiles, so every mutant would otherwise run against a binary that
    // serves nothing — measuring something other than the product.
    assert!(
        mutants.contains("pnpm build"),
        "the UI is not built, so the mutants run against an empty shell"
    );

    // And the summary refuses to call an empty run a clean one.
    assert!(
        mutants.contains("test \"$total\" -gt 100"),
        "a run that mutated nothing would read as a run that caught everything"
    );
}
