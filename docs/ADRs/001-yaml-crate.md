# ADR-001 — YAML crate for server-side frontmatter

- **Status:** accepted, 2026-08-05
- **Supersedes:** the `serde_yaml` cell in SPEC.html §04's architecture table
- **Affects:** P2 (`vault.rs`, `/api/tree`)

## Context

§04 names `serde_yaml` as a server dependency. It is dead. crates.io ships it as
literally `0.9.34+deprecated`, last published 2024-03-25, and
`github.com/dtolnay/serde-yaml` is archived with "This project is no longer
maintained." in its README. It will never receive a fix.

The vault format does not change either way — frontmatter stays ordinary YAML —
so this is an implementation choice under hard rule 6, not a §04 format change
under hard rule 1. No major version is implied.

What the server actually needs is narrower still. `GET /api/tree` reads every
note and extracts exactly **two** frontmatter fields: `title` and `tags`. The
`ref` is not read from frontmatter at all — it is derived from the filename,
because §04's invariant is `filename = ref-slug` and a filename cannot be
mistyped into a different YAML scalar type the way an unquoted `ref: 003` can.
`id`, `created` and `modified` are the client's business. The surface is also
**parse-only**:

- Saves go through `PUT /api/note/{path}`, which takes the complete markdown as
  a byte body. The client owns serialization (§05, `app/src/core/frontmatter.ts`).
- `register new` (P8) writes frontmatter from a fixed template. §09 requires
  scaffold output to be byte-exact against the §04 template, and a serializer
  makes its own formatting choices, so `format!` is the correct tool there —
  not a YAML emitter.

The weighting property is robustness on hostile input. These files are written
by coding agents and by humans in ordinary editors, so the parser sees malformed
input as a matter of course. Rule 9 forbids `unwrap()` outside tests, and a
panic or stack overflow while serving one bad note is an availability bug in a
long-running process.

## Decision

Use **`serde-saphyr`**, deserialize-only:

```toml
serde-saphyr = { version = "1", default-features = false, features = ["deserialize"] }
```

Add it in P2, when there is code that uses it. It is deliberately not in
`Cargo.toml` yet.

## Consequences

- Pure Rust. Its parser core declares `#![forbid(unsafe_code)]`. The alternative
  reaches YAML through `libyaml-rs`, whose own crates.io description is "libyaml
  transpiled to rust by c2rust" and which contains 242 `unsafe` sites.
- Recursion and node-count budgets are on by default and return `Err` with line
  and column rather than aborting.
- Costs ~711 KiB and 19 locked packages, against ~149 KiB and 14 for the
  runner-up. Both are immaterial against the §06 10 MB binary budget.
- Duplicate keys become a hard error instead of last-write-wins. This is a
  behaviour change from `serde_yaml`: a note with two `id:` lines will surface
  an error from `/api/tree`. Keep it — silently discarding half of a conflicting
  frontmatter key is worse than saying so. `DuplicateKeyPolicy` relaxes it if
  real vaults prove otherwise.
- Licensing stays clean: MIT OR Apache-2.0, and we take the MIT arm. Two
  transitive crates (`encoding_rs`, `unicode-ident`) carry conjunctive
  attribution terms, which belong in a third-party notice if releases ever ship
  one. Nothing is Apache-2.0-only and nothing is copyleft.
- §04's architecture table still says `serde_yaml` and is now out of sync. That
  is documentation debt to clear at the next spec revision, not a version event.

## Alternatives considered

**`yaml_serde`** — the YAML organisation's fork of dtolnay's crate. Drop-in via
Cargo package renaming, so zero code churn, and a third of the size. Rejected on
unsafe surface, not on demonstrated failure: it binds the same transpiled-C
parser. Honest caveat — the expected argument for rejecting it did not survive
testing. Both finalists were probed with 21 cases including 100k-deep nesting,
alias bombs, unterminated quotes and a 20 MB scalar, and **neither panicked**;
libyaml's scanner is non-recursive and serde bails early on type mismatch. The
case here is design margin (no unsafe, default budgets, faster maintenance
cadence), not a crash anyone reproduced. Someone re-deciding this on panic
evidence alone could reasonably choose `yaml_serde`, and it remains the fallback
if `serde-saphyr` disappoints — the parse surface is one struct, so reversal is
hours.

**`serde_yml`** — rejected outright. RUSTSEC-2025-0068 declares it unsound and
unmaintained.

**No YAML dependency; hand-write a parser for six known fields.** Tempting,
since the schema is fixed and small. Rejected: frontmatter is only *mostly*
predictable. Agents legitimately emit flow sequences, block sequences, quoted
and unquoted scalars, and folded strings, and a parser that handles the subset we
imagined would reject valid vaults written by tools we do not control. §04's
contract is "ordinary YAML", and honouring it means a real YAML parser.

## Risks

`serde-saphyr` reached 1.0.0 on 2026-07-31 — five days before this decision. The
0.0.x line has ~3.7M downloads so the code is exercised, but the 1.0 API has
almost no field time. `Cargo.lock` is committed and CI installs `--locked`, so
the version cannot move underneath us without a reviewable change.
