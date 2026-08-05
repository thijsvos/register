# ADR-005 — Playwright is the only thing that can check a budget about the browser

- **Status:** accepted, 2026-08-06
- **Affects:** P11 (`app/e2e/`, `.github/workflows/ci.yml`)

## Context

Four of §06's eight budgets are claims about a running browser: agent-edit to
paint ≤ 100 ms, document switch < 16 ms, server start → editable < 500 ms, and
idle RSS ≤ 50 MB on a 1k-note vault. So are §01's mouse-free promise and §02's
"zero animations except the status LED". None of them can be checked by a unit
test, and all of them had been asserted in prose for eleven phases.

They were also the budgets most likely to be wrong, because nothing was watching
them. That turned out to be true: the first run put start → editable at 566 ms,
a document switch at 272 ms and an agent edit at 158 ms.

§08 P11 names Playwright directly ("Playwright against the real binary"), and
§06's testing table already lists it for the §02b screenshot baselines. Rule 6
requires an ADR and approval for any new dependency regardless, which is what
this is.

## Decision

Take `@playwright/test` 1.62.1 as a dev dependency, with Chromium only.

**Against the release binary, never against `vite dev`.** Every §06 budget is a
claim about what ships, and what ships is one Rust binary with the UI embedded
in it. Each spec starts its own `register serve --port 0` over its own temporary
vault and reads the bound address out of the banner, so nothing shares state and
no spec depends on the previous one.

**Measured inside the page.** Playwright's `expect` polls on a schedule starting
at 100 ms, so a 100 ms budget measured that way reports the polling interval.
The budget specs arm a `MutationObserver` and read `performance.now()`, which is
how the agent-edit figure went from "126 ms, failing" to a real number.

## Consequences

- Four budgets, the mouse-free session and the motion doctrine are now enforced
  rather than asserted. CI gains an `e2e` job.
- It found three real defects that eleven phases of unit tests could not:
  - **The caret opened notes at byte zero**, before the `---`. The first thing
    anyone typed pushed the opening fence off byte zero, `split` then found no
    frontmatter, and the note stopped parsing as a note. Fixed by landing the
    caret past the closing fence (`bodyOffset`).
  - **⌘K was dead whenever the User-Agent lied.** The platform check trusted
    `navigator.userAgentData.platform`, which is derived from the UA string, over
    `navigator.platform`, which reports the real OS. Any Mac running a
    UA-spoofing privacy extension had no command palette. Now either signal
    saying "mac" is enough.
  - **The corpus fill starved the user.** `CORPUS_CONCURRENCY` was 8 against a
    browser limit of 6 connections per origin, so every request the user made
    queued behind a thousand background reads. Three fixed all three latency
    budgets at once.
- ~95 MB of Chromium per machine, downloaded on demand and never committed. CI
  installs it in the e2e job only.
- Apache-2.0, which is compatible with this repository's MIT.

## Alternatives considered

**No browser tests at all.** The status quo through P10, and the reason three
defects survived to P11. Two of them are invisible to any test that does not
render: a caret position and a User-Agent string.

**Vitest with jsdom or happy-dom.** Cheaper, and would have caught the caret bug.
It would not have caught the others: jsdom has no layout, no real CodeMirror
rendering, no `getAnimations()`, no connection pool, and no honest clock — so
every latency budget would still be unmeasured, which is most of what P11 is for.

**WebdriverIO or Puppeteer.** Puppeteer is Chromium-only with no test runner and
no expect; WebdriverIO needs more configuration for the same result. Playwright
is what §06 and §08 already name, and matching the spec costs nothing here.
