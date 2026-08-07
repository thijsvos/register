# Contributing

Read `SPEC.html` end to end before anything else. It is the contract, not a
description of one — where this file and the spec disagree, the spec wins.

## Two commands to a running app

```sh
cd app && pnpm install && pnpm build
cd .. && cargo install --path . --force && register init ~/vault && register serve ~/vault
```

`--force` matters: `cargo install` silently does nothing when the version has
not changed, and you keep running the binary you built last time.

## The scope fence

v1 ships **five things to instrument grade** — notes, links, tags, tasks,
search — and nothing else (§01). That is not a statement about what the product
should eventually be; it is a statement about what "done" means for v1. A sixth
feature done well still makes v1 late, and a sixth feature done badly makes the
five worse.

So a pull request that adds a capability outside those five will be parked
rather than merged, however good it is. Parking is not refusal — see below.

## Deferred ≠ declined

§12 is explicit that "not in v1" must never harden into "not ever". Anything —
including things nobody has imagined yet — may land once it passes three gates:

1. It can be expressed without breaking the **§04 vault contract**, or it bumps
   the major version with a documented migration.
2. It fits the **§06 budgets**, or it ships as lazy-loaded / optional code.
3. It obeys the **§02 design system**.

The process is **roadmap entry → ADR → milestone**:

- **Roadmap entry** in `docs/ROADMAP.md`: what, why it is parked, and the
  trigger that would un-park it. Every entry names a trigger; an entry without
  one is a wish.
- **ADR** in `docs/ADRs/NNN.md` once it is real: the decision, what was measured,
  and what was given up. ADR-003 is the model — it exists because
  `@codemirror/lang-markdown` measured 175 kB against a 150 kB budget, and the
  number is in the file.
- **Milestone**: it ships.

## The one permanent constraint

Gates 1 and 2 are negotiable in principle: the vault format can take a major
version, and a budget can be re-argued with numbers.

**§02 is not.** The design system — monochrome plus one signal colour, 1px
hairlines, inverse video instead of glow, design tokens only, zero animation
except the status LED, focus rings always visible — is the thing this product
is. A feature that needs a second accent colour or a fade transition is a
feature for a different product.

`app/src/doctrine.test.ts` enforces this rather than asking politely. It fails
the build on a hardcoded colour, a hardcoded length, an untokenised font
family, any transition, any keyframe outside the status bar, and a font fetched
over the network.

It cannot see a font file committed outside `app/public/fonts/`, because every
glob it uses is rooted there. The `fonts` job in CI covers that case: it greps
`git ls-files` for any `.woff`/`.woff2`/`.ttf`/`.otf`/`.eot` outside that one
directory, and for `berkeley` or `tx-02` in a tracked path under any extension
at all. A licensed face belongs in the vault you licensed it for — §03 is
bring-your-own-font, and nothing a `git push` carries may contain one.

## Hard rules

These are in `CLAUDE.md` in full. The ones that bite most often:

- **§04 vault format is normative.** Changing it is a major version and needs
  explicit approval first.
- **Design tokens only.** Never hardcode a colour, font or size.
- **Budgets are law (§06).** If a change breaks a budget, shrink the change, not
  the budget.
- **Files are the truth.** No database, no `localStorage`, no IndexedDB, no state
  the vault cannot express.
- **Every vault write goes through `vault.rs`** — atomic tmp+rename, guarded by
  an etag. Nothing else opens a file for writing.
- **No new dependency** — crate or npm — without an ADR and approval.
- **Fonts: OFL only**, with `OFL.txt` beside them. Berkeley Mono / TX-02 must
  never enter the repository; it is bring-your-own-font, loaded from the user's
  own disk into their own vault (§03).
- **Rust: clippy clean with `-D warnings`, no `unwrap()` outside tests.
  TypeScript: strict.**

## What green means

A change is done when all of these pass. Not most.

```sh
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd app && pnpm check && pnpm test && pnpm build && pnpm size
cd app && pnpm e2e          # Playwright, against the release binary
```

**The UI is embedded in the binary.** A UI change you have only `pnpm build`-ed
is not in the binary until you `cargo install --path . --force`, and the
symptom is a fix that appears not to work. `register serve --assets app/dist`
reads the UI from disk instead, which is the fast loop for anything visual.

The container has the same shape of trap: `docker compose up` reuses the image
it built last time, so building from source needs `up --build` or your change is
not in there at all.

`pnpm e2e` needs the binary built first (`pnpm build && cargo build --release`),
because it drives the shipped artefact rather than a dev server — every §06
budget is a claim about what ships.

**Check the exit codes, not the output.** A vitest run whose import throws prints
a summary that looks like success; this repository has shipped a commit claiming
a green suite that was exiting 1.

One conventional commit per unit of work, and the message says what was
measured, not just what changed.
