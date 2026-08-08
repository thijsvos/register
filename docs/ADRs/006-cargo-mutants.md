# ADR-006 — `cargo-mutants` for the server

**Status:** accepted · **Date:** 2026-08-08

## Decision

Add `cargo-mutants` as a scheduled CI job over `src/`. It runs weekly and on
demand, never on a pull request.

It is a tool CI installs at a pinned version, not a crate in `Cargo.toml`:
nothing links against it and `cargo build` does not know it exists.

## The problem

This repository's failure mode is not missing tests. It is **tests that pass
while the thing they guard is broken**, and the evidence is a list, not a worry:

- A test asserting the Dockerfile passes `--locked` was satisfied by a *comment*
  mentioning `--locked`. Deleting the flag from the real line kept it green.
- The same defect, in the same file, recurred six commits after being fixed and
  written up.
- A test written to replace an outcome-conditional guard shipped with the
  identical defect one step earlier.
- `audit.spec.ts` claimed in a comment to press `I`, pressed `]` and `[`, and
  INV was dead for four phases behind it.

Every one was found by a person reading carefully. That does not scale, it does
not run while nobody is looking, and by now it has demonstrably failed twice on
the same file.

## What it measures, and why it is the right measurement

Coverage answers "did this line run". Every serious bug this project has had was
in code the tests already executed:

| Bug | Coverage before the fix |
|---|---|
| `Authenticated` handed the vault to any LAN peer | `token_gate` runs on all ~100 server tests |
| A vault's `.git/config` was unauthenticated RCE | `/api/tree` exercised 17×; `git::status` on each |
| INV dead since P9 | `view.svelte.ts` executed by four e2e specs |

Mutation testing answers the question that actually matters: **if this code were
wrong, would anything fail?** It breaks the code in small, plausible ways and
reports which changes no test noticed.

## Measured, before deciding

First run, whole crate, `cargo-mutants 27.1.0`:

```
366 caught · 39 missed · 405 mutants
```

90.4% of injected faults were detected. The 39 survivors were triaged, and they
split cleanly:

**Genuine gaps, now closed:**

- `src/server.rs:123` — replacing `|` with `^` in `constant_time_eq` survived
  every test. That is a **token bypass**: with XOR the accumulator becomes a
  parity, so two byte-pairs whose deltas match cancel to zero. `uhnter…`
  authenticates against `hunter…`. The existing test checked equal, unequal,
  different-length and empty — none of which distinguishes the two operators.
- `src/vault.rs:300` — replacing `require_root` with `Ok(())` survived. Without
  it a write after the vault is renamed resurrects the old tree and answers 200
  while the note goes somewhere nobody is watching.

**A gap that stays open, deliberately:**

- `src/vault.rs:249` — replacing `verify_parent` with `Ok(())` still survives,
  and a test was written before that was understood. `verify_parent` is the
  *second* look at containment, after `create_dir_all`. The first look,
  `verify_contained`, rejects every symlink a test can plant in advance — so the
  only input that reaches `verify_parent` is one where the link appears
  **between** the two calls. Killing this mutant means winning a race on demand.
  The test written for it is kept because it proves the write does not escape;
  it is honest that it proves that via `verify_contained`, not this guard.

  This is the first entry in what should be a short, reasoned list. A survivor
  with a written reason is a decision; a survivor nobody looked at is the thing
  this ADR exists to prevent.

**Not worth testing, and deliberately not tested:** the seven `media_type` match
arms (a wrong content type for `.ico` is not a defect worth a test), `now_millis`
and `unix_seconds` replaced by constants, `Display for Error`'s formatting, and
the ULID entropy shifts. These are noise in the signal, which is expected and is
why the job reports rather than gates.

Finding a real credential-comparison flaw on the first run is the whole argument.

## Why not on every pull request

The full run takes tens of minutes: each mutant is a separate build and test
cycle. Blocking a PR on that trades a fast gate for a slow one, and the survivors
need human triage — most are noise. A weekly report that a person reads is worth
more than a red X nobody can act on.

Scoped to `src/`. The frontend equivalent is StrykerJS, which is a separate
decision: much of `app/src` needs a browser, and ADR-005 already settled that
those behaviours are proved by Playwright against the shipped binary.

## What was given up

- **It does not gate.** A surviving mutant will not stop a merge, so acting on
  the report is a habit rather than a mechanism. Accepted: the alternative is a
  slow, noisy gate that gets ignored or disabled, which is worse.
- **Some survivors will never be killed**, and the noise makes the number look
  worse than the suite is. The score is a trend to watch, not a target to hit.
- **CI minutes.** Free on a public repository with standard runners.

## Alternatives

- **Keep doing it by hand.** What we have been doing. It found real bugs, and it
  also let the same defect recur in the same file six commits later.
- **Coverage instead.** Would have flagged none of the three bugs in the table
  above. Worth adding as a map, but it is not this decision.
- **Gate on PRs.** Rejected on time and noise, above.
