# REGISTER — agent operating manual

*Written by the maintainer to the coding agent working in this repository. "I"
and "my" are the maintainer throughout. If you are a human contributor, the file
you want is [`CONTRIBUTING.md`](CONTRIBUTING.md) — it says the same things
without the imperative mood.*

Read `SPEC.html` before any task. It is the contract. `register-prototype.html`
is the visual + interaction reference for the UI (a static mock, not the
implementation — rebuild it on the real stack in §04). Where the mock and a §02b
frame disagree, §02b wins.

This file is the repo agent manual (§08 B). It is not the vault `CLAUDE.md`:
that one is the §04 agent contract, written verbatim into every vault by
`register init` (P8). Never merge the two.

## Commands
```
cargo run -- serve ./devvault      # run server against a test vault
cargo test · cargo fmt · cargo clippy -- -D warnings
cd app && pnpm dev                 # UI dev (proxies /api to :7777)
cd app && pnpm check && pnpm test && pnpm build && pnpm size
```

## Hard rules
1. §04 vault format is normative. Any change to it is a major version and needs
   my explicit approval first.
2. Design tokens only (§02). Never hardcode a color, font, or size; everything
   derives from `app/src/styles/tokens.css`. Every component matches the §02b
   state matrix; every screen matches its §02b wireframe.
3. Budgets are law (§06). If a change breaks a budget, shrink the change, not
   the budget.
4. Files are the truth. No databases, no localStorage, no state the vault
   cannot express. IndexedDB is forbidden.
5. All vault writes go through `vault.rs` atomic write + etag. Never write files
   any other way.
6. No new dependencies (crate or npm) without `docs/ADRs/NNN.md` and my approval.
7. Fonts: only OFL faces with `OFL.txt` beside them (§03). CI greps for strays.
   Berkeley Mono / TX-02 must never enter the repo — BYOF only.
8. Zero animations except the status LED; respect `prefers-reduced-motion`; keep
   focus rings visible. Dark theme is tuned per §02 ("one ink, tuned per
   surface"), never inverted maximum contrast.
9. TypeScript strict; Rust clippy clean with `-D warnings`.
10. A phase is done when: `cargo test` + `fmt` + `clippy` AND `pnpm check` +
    `test` + `size` are green — and, where the phase has one, its §02b
    screen/state matches. Then one conventional commit.
11. Version doctrine (§06): before scaffolding, verify every manifest pin against
    current stable (endoflife.date + official release pages) and bump the
    manifest if stable has moved. Pins live in `.nvmrc` / `rust-toolchain.toml` /
    `packageManager` only; `latest` is banned as an image or package version tag
    in Dockerfiles, workflows, and manifests. GitHub runner labels
    (`runs-on: ubuntu-latest`) are exempt — they name GitHub-managed
    infrastructure rather than a dependency, no update bot tracks them,
    and pinning one would create a stale pin nothing owns. Renovate owns drift
    after P0 — it is the only bot with a manager for all three pin files.

## How we work
Build through §08 phase by phase, in order. I paste each phase prompt (P0, P1, …)
when the previous one is accepted; do not run ahead. One conventional commit per
phase. Do not add scope beyond the current phase — parked ideas go to
`docs/ROADMAP.md` per §12, never into the code. If anything is ambiguous or
conflicts, ask before deciding.

## Style
Svelte 5 runes. Small modules. UI copy is plain, directive, instrument-voiced
("No notes match. [N] creates one."). Rust: no `unwrap()` outside tests.
