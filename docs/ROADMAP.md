# Roadmap

Deferred ≠ declined (§12). Anything here may land once it passes three gates:
it fits the §04 vault contract (or bumps the major version with a documented
migration), it fits the §06 budgets or ships lazily, and it obeys §02. Process
is roadmap entry → ADR → milestone.

Two kinds of entry live here. The **§12 table** below is the designed expansion
path — features deliberately left out of v1, each with the landing path that
keeps it contract-safe. Everything after it is a risk or a decision **parked
during a phase**, recorded here rather than in a commit message nobody will
re-read.

Every entry names a trigger. An entry without one is a wish.

## Post-v1 expansion (§12, seeded by P11)

| Deferred feature | Designed landing path (contract-safe) | Prerequisite / trigger |
|---|---|---|
| **Query & table views ("databases")** | Inline queries over frontmatter + tags, evaluated client-side and rendered as §02 tables — the Dataview pattern. Notes stay plain files; a query is just text in a note. | Query-grammar ADR; v1 corpus/store stable. |
| **Kanban / boards** | A view over existing tasks + tags, columns keyed by tag or status. Pure derivation, zero new storage. | The query engine above. |
| **Graph view** | Pure derivation of the backlinks map into a monochrome, hairline-styled panel. No new data — `core/links.ts` already computes it. | Demand-driven; lazy chunk within budget. |
| **Plugin system** | Versioned, capability-scoped extension points (commands, panels, decorations, query functions) once the core API freezes at v1.x. A plugin may never bypass `vault.rs` writes. | API freeze + a security-model ADR. |
| **Richer editing surface** | Deeper live preview — tables, images, math rendered in place — as an evolution of P4's decoration layer. Markdown stays the literal source, and anything that hides the source still answers to §02. | The decoration layer proven in the field. |
| **Realtime co-editing** | Optional CRDT transport layered on top (reopening ADR-001). Files stay canonical; every session flushes to plain markdown. | True multi-writer demand. |
| **Built-in richer sync** | From git checkpoints (P12) toward managed git remotes or an optional relay — always self-hostable, never required. | P12 shipped; user pull. |
| **Importers** | One-way converters (Obsidian, Notion export, Logseq) into the §04 format. Read-only, low risk, high adoption value. | None — the best first post-v1 milestone. |
| **Native shells / mobile ergonomics** | A Tauri wrapper around the same embedded UI. Remote/tailnet mode already serves every device meanwhile. | PWA ergonomics measured insufficient. |
| **E2E-encrypted remote** | Token mode (P12) hardened with encrypted transport, for vaults hosted off-device. | Remote mode adoption. |

## Parked during P2 (server core)

| Item | Why it is parked | Trigger |
|---|---|---|
| **Etag collision window** | §04 mandates `mtime + len`, so two different bodies of identical length written inside one filesystem mtime tick share an etag. Measured sub-microsecond on macOS/APFS, so it is not reachable in practice there; ext4's granularity is coarser. Changing the etag scheme would change §04. | A real collision, or a §04 revision. The client rule meanwhile: an equal etag on a `changed` frame must **not** be read as "no change". |
| **Cross-process write races** | `vault.rs` serialises writes with an in-process lock, which is sufficient because hard rule 5 routes every write through one process. Two `register` instances over one vault would still race. | Anyone runs two servers on one vault — or P12's remote mode makes that ordinary. |
| **Any loopback origin is trusted** | The origin guard allows `http://localhost:<any port>` so `pnpm dev` can proxy from vite. That grants the same authority to every other local web server. Narrowing it needs an explicit dev-origin flag. | P12, alongside token mode — the same conversation about who may talk to the server. |
| **No WebSocket keepalive** | `pump()` has no ping/pong and no send timeout, so a half-open connection is never detected. Harmless on loopback; it matters over a tailnet. | P12 remote mode. |
| **`If-Match: *`** | RFC 9110 defines the wildcard as "matches iff the resource exists". Unimplemented; no client sends it. | A second client, or a spec revision that asks for it. |
| **~~`cargo-audit` in CI~~** | ~~Closed after P11.~~ The trigger was "P10/P11 release engineering, where CI grows anyway", and it did — `ci.yml` now has an `audit` job. It is the check that would have found RUSTSEC-2025-0068 without ADR-001 having to find it by hand. | — |

## Parked during P3 (client store)

Three P3 entries are now closed by SPEC Rev F: refs are never reissued, the
status bar's VAULT field is served, and `/api/tree` and event frames are
validated at the boundary instead of cast. What remains:

| Item | Why it is parked | Trigger |
|---|---|---|
| **A conflict copy is an ordinary note** | `*.conflict-<ts>.md` lands in the tree indistinguishable from any other note, and the only thing announcing it is a status-bar line that the next successful save clears. §02b Screen 4 is the real resolution surface. | The phase that builds §02b Screen 4. |
| **GIT is permanently dashed** | §02b Screen 1's status bar has a GIT field and nothing can fill it: git is P12, and §04's API exposes no git state. | P12. |
| **Cross-tab ref collision** | The server now allocates `nextRef`, so a single client cannot reissue a ref. Two tabs that fetch the tree at the same moment still both receive the same `nextRef`, and because they usually pick different slugs the paths differ — so `create()`'s free-name check passes for both and two notes end up sharing a ref. Closing it needs the server to allocate atomically at write time, which §04's path-addressed PUT cannot express. | Multi-tab or multi-agent creation proving it out; would want a create-if-absent addition to §04. |

## Parked during P6 (search, backlinks, tags)

| Item | Why it is parked | Trigger |
|---|---|---|
| **A tag is not clickable** | The sidebar and inspector show tags with counts and meters, but nothing happens when you click one. Filtering the index by tag — or seeding ⌘K with it — is the obvious next move, and §02b's state matrix defines no tag component, so building one would be inventing where §02b says "do not invent". | A §02b revision that draws the interaction. |
| **Conflict copies are unsearchable** | They are excluded from the index, the link graph and the tag counts, because they carry the original's ref, title and tags and would double every one of them. Reachable only from the index pane. | §02b Screen 4, which is where an unresolved conflict is supposed to be surfaced and merged. |
| **The outline ignores setext headings** | `Title` over `=====` is a heading in CommonMark and does not appear in the OUTLINE pane — because the editor does not style it as one either, and the pane and the page have to agree. Both should change together or neither. | Anyone writing setext in a real vault. |
| **No guard on the chunk graph (P6)** | P6 made the lazy editor chunk share `core/` with the shell, and the bundler answered by hoisting `core/` into the *editor* chunk and having the shell import it statically — all of CodeMirror at boot, invisible to a budget that only weighs `shell-*.js`. Fixed by naming a `core` chunk, and `doctrine.test.ts` now bans a static editor import from the shell side; nothing yet inspects the built output. | P10/P11 release engineering, where a `dist/` assertion belongs with the other CI size checks. |

## Parked during P7 (daily, tasks, templates)

| Item | Why it is parked | Trigger |
|---|---|---|
| **⌘D is claimed twice** | §08 P7 reads "⌘D / GO DAILY opens daily/YYYY-MM-DD.md"; §02b Screen 2 draws the palette row `GO · TODAY / TASKS` with `[⌘D]` against it. Both are normative. Built to the frame — ⌘D opens TODAY, `G D` opens the daily log, and both rows show their key — because the frame is what a user actually reads off the screen. One of the two documents should give. | My call on which; a one-line swap either way. |
| **"Today" is UTC, not local** | `daily/YYYY-MM-DD.md` is named from `toISOString()`, so west of Greenwich the evening's daily log is tomorrow's date. §02 already rules that "timestamps are UTC everywhere in the chrome — local time is never displayed", so making the day local is a doctrine change rather than a bug fix, and not mine to make. | A user outside UTC±0 keeping a daily log; would want §02 to say what a *date* is, as distinct from a timestamp. |
| **A ticked task vanishes with no undo** | §02b Screen 5 lists open tasks, so ticking one removes its row. The count still shows it in `total`, and the source note still holds it, but there is no way back from TODAY itself. | A second look at Screen 5; showing done tasks dimmed and struck through is the obvious alternative and the state matrix already describes that appearance. |
| **Templates are searchable but not actionable** | ~~Closed after P8.~~ A first real vault made the answer obvious: `core/paths.ts` now separates what the INDEX lists from what derivations count, so `templates/` and `CLAUDE.md` are out of the index and the tag meters but still findable in ⌘K. | — |

## Parked during P8 (init + agent contract)

| Item | Why it is parked | Trigger |
|---|---|---|
| **~~The e2e stops at the frame, not the pixel~~** | ~~Closed by P11.~~ Playwright arrived with ADR-005 and `e2e/budgets.spec.ts` now measures the paint itself, with a MutationObserver rather than a poll. The Rust test still measures the frame at 48 ms; the browser measures what follows it. | — |
| **`register new` only works inside the vault** | It reads the current directory and refuses elsewhere, because §08 P8 specifies the command as `register new "title"` with no path. Convenient, but it means an agent must `cd` first. A `--vault` flag would fix it and is one line. | Anyone scripting note creation from outside the folder. |
| **Slug folding is partial, not NFKD** | The client normalises with `normalize('NFKD')`; Rust's std has no Unicode normalisation, so `scaffold::slug` folds the Latin-1 accented range by hand and lets everything else become a dash. `Café notes` matches on both sides; a Cyrillic or CJK title does not — it slugs to `untitled` in the CLI. The ref still identifies the note either way. | A vault in a non-Latin script, or a Unicode crate arriving for another reason. |
| **Two `register` processes can still race** | `create` checks the name is free and then writes, and the check is outside the vault's write lock. One process cannot collide with itself; two can. Same root cause as the P2 entry on cross-process writes. | The same trigger as that entry — anyone running two instances over one vault. |

## Parked during P9 (BYOF + font themes)

| Item | Why it is parked | Trigger |
|---|---|---|
| **A theme change dirties the repo** | `.register/config.json` is tracked — §08 P8 names only `fonts/` and `trash/` for .gitignore — so flipping to dark shows as a modification in a vault under git. Defensible either way: your scheme is vault state and might reasonably travel between your own machines, but it also pushes your theme at a collaborator. Pinned by a test so the choice stays deliberate. | A shared vault, or anyone irritated by a dirty status after touching settings. |
| **The scheme has no third button** | §02b Screen 6 draws `[ Light ][ Dark ]` and no "system", so pressing the lit one returns to following the OS. That is the only way back to the default and nothing on screen says so beyond a line of hint text. | A §02b revision that draws the control with three states. |
| **BYOF is one face, not a family** | One licensed file per vault, registered as `TX-02` with whatever weight it carries. A user who owns regular *and* bold gets only one of them, and the app synthesises the other. §03 describes the loader in the singular; supporting a family means naming weights in the UI. | Anyone loading a licensed face and finding bold looks wrong. |
| **`register init` does not commit** | `--git` initialises the repository and writes .gitignore but makes no first commit, so a fresh vault's status is a wall of untracked files. Deliberate — committing on someone's behalf is a decision — but it means "git status stays clean" only reads true after you commit once. | P10/P11, where release engineering decides what a scaffolded repo should look like. |

## Parked during P10 (release engineering)

| Item | Why it is parked | Trigger |
|---|---|---|
| **~~`docker compose up` is unverified~~** | ~~Closed.~~ Verified after the machine's Docker daemon was restarted: the image builds to **3.28 MB**, `docker compose up` serves `:7777` against the mounted vault, a `PUT` through the container lands on the host filesystem, and — the part most likely to have been broken — the watcher inside the VM sees a **host** edit through the bind mount in **15 ms**. | — |
| **The image is amd64 only** | `deploy/Dockerfile` builds for the host architecture, and the release workflow pushes what the runner produced. §07's own remote pattern is a home server behind Tailscale, which is as likely to be an arm64 Pi as an x86 box. Building both under QEMU means a Rust release build through emulation; the fast route is a second Dockerfile that `COPY`s the binaries the matrix already cross-built. | Anyone pulling the image on arm64. |
| **No `latest` image tag is published** | Rule 11 bans consuming a floating tag, and publishing one is how a floating tag comes to exist. So the image is addressable only as `:v1.2.3` / `:1.2.3`, and `docker pull ghcr.io/OWNER/register` with no tag will fail. Documented in the README; it is a real friction, traded for a real hazard. | A decision that the convenience outweighs the doctrine — which is a spec change, not a code change. |
| **The release workflow has never run** | It cannot: it fires on a `v*` tag against a GitHub remote this repo still does not have. Every checkable property — the five targets, the 10 MB gate, the tag trigger, the ghcr push, no floating tags — is asserted in `tests/release.rs`, and all four mutations of those were verified to fail. What remains untested is GitHub itself. | The first `git push --tags`. |

## Parked during P11 (QA hardening)

| Item | Why it is parked | Trigger |
|---|---|---|
| **No §02b screenshot baselines** | §02b asks for "a Playwright screenshot story per screen, light and dark, diffed against a committed baseline". Playwright is now here and one screenshot is committed for the README, but per-screen visual diffing is a separate discipline: baselines are platform-specific, and a suite that fails on a font-rendering difference between macOS and CI teaches people to ignore it. | A decision about where baselines are generated — almost certainly a container, so one platform owns them. |
| **The e2e budgets are measured on one machine** | The numbers are real but they are this laptop's. §06 says the RAM budget is "an e2e measurement on CI profile", and CI has not run. A GitHub runner is slower and the thresholds may need to be honest about that rather than generous. | The first CI run of the `e2e` job. |
| **Frontmatter is shown in the editor** | Markdown stays the literal source (§02), so every note opens with six lines of YAML above the prose. Correct by doctrine, and the caret now lands below it — but it is the first thing anyone sees, and folding it is the obvious next question. | A §02 ruling on whether folding counts as hiding the source. |
| **`register serve` has no `--open`** | Every run prints a URL you then click. Trivial to add, and one more thing between clone and running. | The "stranger goes clone → running in two commands" claim being tested on an actual stranger. |

## Parked during P12 (checkpoints + remote mode)

| Item | Why it is parked | Trigger |
|---|---|---|
| **~~GIT is permanently dashed~~** | ~~Closed by P12.~~ The tree envelope carries `{clean, ahead}` and §02b Screen 1's GIT field shows CLEAN / DIRTY / N AHEAD, or `—` when the vault is not a repository. | — |
| **A checkpoint sweeps the staging area** | It runs `git add -A`, so anything you had part-staged with `git add -p` joins the checkpoint. Off by default, and the alternative — committing only what the app touched — needs a list of what the app touched, which the watcher has but the committer does not. | Anyone using the index deliberately in a checkpointed vault. |
| **`git status` runs on every tree fetch** | Cheap on a repository this size and skipped entirely for a non-repository, but the tree is fetched after every event burst, so a very large repo would pay for it repeatedly. A short-lived cache is the obvious fix and was not worth guessing at. | A vault where `git status` is slow enough to notice. |
| **Remote mode has no TLS** | Deliberate — §07's pattern is a tailnet, which is already encrypted, and terminating TLS is a reverse proxy's job. But a user who binds `0.0.0.0` on an untrusted network sends their notes and their token in clear. The token gate cannot tell those cases apart. | An encrypted-remote milestone; §12 already lists "E2E-encrypted remote". |
| **The token lives in one process, not in a file** | No accounts, no user table, no revocation list — the token is an argv string, so rotating it means restarting the server, and it is visible in `ps` to anyone already on the machine. Right for a tailnet; thin for anything more exposed. | The same milestone as TLS. |
