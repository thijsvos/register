# ADR-003 — the markdown language is built from `@lezer/markdown`, not `@codemirror/lang-markdown`

- **Status:** accepted, 2026-08-05
- **Affects:** P4 (`app/src/editor/`)

## Context

§04's architecture table names the editor stack as "CodeMirror 6 +
lang-markdown + custom live decorations (lazy chunk)". §06 budgets that lazy
chunk at **150 kB gzipped**.

Both cannot be satisfied. Line 6 of `@codemirror/lang-markdown`'s dist is:

```js
import { html, htmlCompletionSource } from '@codemirror/lang-html'
```

A *static* import, so it transitively pulls `@codemirror/lang-javascript`,
`@codemirror/lang-css`, `@codemirror/autocomplete`, `@codemirror/lint` and three
more Lezer grammars. Those modules have side-effectful initialisation, so no
bundler can shake them out and no `markdown({ codeLanguages: [] })` configuration
removes them.

Measured on this repo's real build, same harness, only that import changed:

| Language source | Chunk (raw) | Chunk (gzip) | 150 kB budget |
|---|---|---|---|
| `markdown()` from `@codemirror/lang-markdown` | 503 kB | **175 kB** | fails by 25 kB |
| `Language` built from `@lezer/markdown` + GFM | 315 kB | **103 kB** | passes |

## Decision

Assemble the `Language` directly from `@lezer/markdown`'s parser, configured
with the `GFM` extension. `@codemirror/lang-markdown` is not a dependency.

GFM is not optional here: `- [ ]` only parses into `Task` / `TaskMarker` nodes
with that extension, and those nodes are what P4's checkbox decoration attaches
to. Plain CommonMark has no task lists.

Hard rule 3 decides it — "if a change breaks a budget, shrink the change, not the
budget" — and the vault format is untouched either way, so this is a rule 6
dependency choice rather than a §04 format change.

## Consequences

- ~72 kB gzipped of code the product never executes stays out of the bundle, and
  the editor lands at 103 kB with 47 kB of headroom for P5–P7 decorations.
- **Given up:** syntax highlighting *inside* fenced code blocks (that is what
  `lang-html` and friends provided), and `markdownKeymap` — the smart list and
  blockquote continuation on Enter. Neither is named in §02 or §02b. If list
  continuation is wanted later, port those commands by hand rather than importing
  `lang-markdown`, which costs the whole 72 kB the moment anything touches it.
- The `fenced code boxed per §02` requirement is met by the decoration layer
  drawing the hairline, which never needed the language for it.
- §04's architecture table should say `@lezer/markdown` at the next revision.
  Documentation debt, not a version event.

## Alternatives considered

**`commonmarkLanguage` from `@codemirror/lang-markdown`.** Measured 98.6 kB —
it tree-shakes clean because, unlike `markdown()`, it never references `html`.
Keeps §04's named dependency and is 0.2 kB *smaller*. Rejected for two reasons:
it has no GFM, so task lists do not parse and P4's central interaction dies; and
it leaves a 72 kB landmine one import away, where a future phase writing
`markdown()` out of habit silently blows the budget. Installing neither package
means the mistake is unavailable.

**`basicSetup` from the `codemirror` meta-package.** 131 kB, passes with 18 kB
headroom, and drags in autocomplete, lint, search, a fold gutter and line
numbers — every one of which §02 explicitly does not want.

**`@codemirror/basic-setup`.** Dead: last published at 0.20.x from the CM6 beta
era. Not part of the 6.x line at all.
