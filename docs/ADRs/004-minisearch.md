# ADR-004 — MiniSearch is the search index, and it is kept warm rather than built on demand

- **Status:** accepted, 2026-08-05
- **Affects:** P6 (`app/src/core/search.ts`, `app/src/ui/App.svelte`)

## Context

§04's architecture table already names the dependency — "Search · MiniSearch,
client-side over the loaded corpus · MIT · ~7 KB" — and P6's prompt repeats it,
so the choice is the contract's rather than mine. This ADR exists because hard
rule 6 requires one for any new package, and because the *shape* of the
integration is a real decision that the contract does not make.

The measurement that decides it, on this repo's build, 1 000 synthetic notes of
~60 lines each:

| Operation | Cost |
|---|---|
| Build the index from cold | **99 ms** |
| Fold in one changed note | 0.3 ms |
| Search (worst of six queries) | **1.1 ms** |

P5's gate is "palette opens < 16 ms". A cold build is six times that on its own,
so an index constructed when ⌘K first opens would miss the budget by an order of
magnitude on exactly the vault size §06 sizes the RAM budget for.

## Decision

Take MiniSearch 7.2.0. Wrap it in `SearchIndex`, which is **incremental** —
`sync(notes, corpus)` diffs the tree against what it already holds, keyed by
etag, and returns how many documents it had to index — and **warm**: `App.svelte`
syncs it from boot, so the 99 ms is paid one arriving body at a time as the
corpus fills behind the tree, and every later sync is a 0.3 ms no-op.

Two deviations from a stock configuration, both load-bearing:

- **`ref` is an indexed field**, alongside §02b's title/body/tags. A ref is how
  §04 addresses a note — `[[003]]` is a first-class link — so a palette that
  cannot find `003` cannot find the vault's own primary key.
- **Fuzziness is off for short and numeric terms.** At MiniSearch's ratio of 0.2
  a three-character term tolerates one edit, which puts every ref in the vault
  within one edit of every other: typing `003` returned `004` and `005` as well.
  Longer words keep it, so `sixten` still finds "sixteen".

Frontmatter is stripped before indexing. Every note carries `modified` and an
`id`, so indexing it would make one term match the whole vault and put a line of
YAML in the excerpt.

## Consequences

- The palette searches bodies, which is what §02b demands of it: "⌘K must run
  real full-text search over the corpus, not filter a fixed command list."
- Shell JS goes from 24 kB to 32 kB gzipped against a 60 kB budget. MiniSearch is
  most of that ~7 kB, as §04 predicted.
- The index is memory the vault does not describe, which is allowed — hard rule 4
  forbids *state* the vault cannot express, and this is a derivation that is
  thrown away on reload and rebuilt from the files. Nothing is persisted.
- Conflict copies are left out of the index, as they are left out of the link
  graph and the tag counts (§04 calls them artefacts to merge, and they carry the
  original's title verbatim). They stay visible in the index pane, so they are
  reachable; they are simply not searchable. Parked in `docs/ROADMAP.md` against
  §02b Screen 4, which is where a conflict is supposed to be resolved.

## Alternatives considered

**Hand-rolled inverted index.** A tokenizer, a postings map and a scorer is maybe
80 lines and no dependency — but prefix search, fuzzy matching and BM25-ish
ranking are the parts that make a palette feel like one, and they are where the
80 lines become 400. §04 already priced the dependency at 7 kB against a 60 kB
budget with 28 kB spare.

**Server-side search.** Rejected by §04 on sight: "Refs, links, tasks, tags,
search — all client-side derivations of plain text, so the file format alone
defines the product." It would also add a sixth endpoint to a five-endpoint
surface the spec calls complete.

**Building the index lazily on first ⌘K, with a spinner.** Misses the 16 ms gate,
and §02 permits no animation but the status LED — so there is no spinner to show
and nothing to fill 99 ms with except a frozen palette.
