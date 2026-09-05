# ADR-008 — An extract is the served app folded into one file, not a second renderer

- **Status:** accepted, 2026-09-05
- **Affects:** §12 (`src/extract.rs`, `app/vite.extract.config.ts`,
  `app/src/core/offline.ts`, `app/src/core/api.ts`, `app/src/editor/setup.ts`,
  `app/src/ui/Palette/commands.ts`), §06 (three budgets), §02b (Screen 1's
  first status cell, Screen 6's stamp)

## Context

REGISTER could take a vault in — `register import` — and render one live, and
nothing ever came out. That was a gap rather than a decision: §12's ten
deferred rows are query views, kanban, graph, plugins, tables and math,
co-editing, sync, importers, native shells and encrypted remote, and the
roadmap's hundred-odd entries name no export, no archive, and no way to hand a
reading of a vault to anyone who does not run the binary.

Three facts made the gap cheap to close, and they decide the shape of what
closes it:

1. **The binary already carries the UI.** `rust-embed` puts `app/dist` inside
   it. Whatever an extract is, the reader half is bytes the binary already has.
2. **Every derivation is already client-side.** Search, backlinks, tags, the
   outline, TODAY, ATTACHMENTS and the folder tree are computed in the browser
   from the corpus. The server contributes `nextRef`, git state, and writes —
   none of which a reading needs.
3. **The wire is one module.** `app/src/core/api.ts` holds every `fetch` and
   the one `WebSocket`. One seam.

So an extract is: the vault's answers written inline into a page, and the same
UI reading them from there instead of from a socket.

## Decision

`register extract <vault>` writes one HTML file holding the tree, every note's
bytes, the images and PDFs the vault holds as `data:` URLs, the OFL faces
inlined, and a second build of the app — `app/vite.extract.config.ts`, which
folds the shell, the core and the lazy editor into one script under a name the
Rust side can address. The page opens from disk, reads with the same CodeMirror
the served app writes with, and asks nothing of anyone.

**Why the same app and not a renderer.** A markdown-to-HTML path would be a
second implementation of every decoration — wikilinks, embeds, tasks, the
frontmatter fold, setext headings — and it would drift from the first the day
after it shipped. `EditorState.readOnly` and `EditorView.editable(false)` are
two facets; the surface is otherwise byte-identical, which is what makes the
extract *read* as the product rather than as an export of it. The cost is the
editor chunk's weight in every extract, ~480 kB raw. Accepted: the chrome is
budgeted at 800 kB and measured well inside it.

**Why a second Vite config and not a flag.** `inlineDynamicImports` and
`manualChunks` cannot both be set, and the served config's chunking is exactly
what `doctrine.test.ts` exists to keep — a shell that paints first and an
editor that stays lazy. The two builds disagree on purpose; one config each
keeps the disagreement legible.

**Why the transport seam is in `api.ts` and not a `fetch` shim.** A patched
`fetch` would leave `<img src>` and `<iframe src>` pointing at `/api/file/…`,
which a page opened from disk cannot serve, so `fileUrl` has to change either
way — and a module that says "the whole server surface" in its first line is
where a second answer to every read belongs. `offline.ts` finds the payload;
`api.ts` answers from it; a served page has no payload and never takes those
branches. Every write refuses with one sentence, `READ_ONLY`, which every
caller already reports as a notice — so a path nobody thought to gate still
says what happened rather than failing silently.

**Why `connect-src 'none'`.** A single file needs `'unsafe-inline'` for its
script, which is the thing the served app's policy exists to forbid. The
extract's policy is turned the other way: everything inline, and no way out.
`connect-src 'none'` is enforced by the browser before a line of script runs,
so the claim the README makes — an extract cannot phone home — is the file's
own header rather than a promise, and `e2e/extract.spec.ts` records every
request the page makes to hold it. There is no HTML-injection vector to weigh
against the inline allowance: REGISTER renders markdown through CodeMirror, as
text, and the payload is JSON with `<`, `>` and `&` written as escapes so no
note can close the block it sits in.

**What is never carried.** Nothing under `.register/` — the trash, the config,
and above all the licensed face (§03, rule 7): a file made to be handed on must
not carry bytes the user paid for. And not the vault's absolute path: the tree
names the folder, not where it lived. Both are tests.

**Why the bundle rides in `Assets` and is refused by the server.** The tidy
shape — a second `#[derive(Embed)]` over `app/dist/extract` and an
`#[exclude]` on the first — costs rust-embed's `include-exclude` feature,
which pulls in a glob matcher: a crate, under rule 6. So `pnpm build` writes
the extract's bundle into `app/dist/extract/`, one `Assets` embeds it once,
`extract.rs` reads it from there alongside the fonts and the boot script, and
`asset()` answers `/extract/*` with 404 so a served page's surface is exactly
what `index.html` asks for.

**Why an extract is written beside a vault, never into it.** Into it would put
a file the tree never shows under the watcher, the importer's walk and
`git add -A`, and the next extract would carry the last one. `-o` naming a
path inside the vault is refused; a file that exists and is not an extract is
refused too, so a mistyped `-o` cannot cost somebody a page of theirs.

## Alternatives considered

- **A static-site export** (a folder of HTML). Many files, a server or a
  `file://` directory to navigate, no search without a script anyway, and a
  second renderer. The one-file shape is the whole of the value: it is a thing
  you can attach, hand over, or keep.
- **Carrying history.** `getHistory` and `getLedger` could be baked in the
  same way. Multiplies the size by the depth of the log for a question — how
  did this note get here — that the reading of a vault as it stands does not
  ask. Parked with a trigger.
- **A `fetch` shim** — above.
- **`inlineDynamicImports` on the served build**, with the extract reading
  `app/dist` as is. Kills the lazy editor for every served page to save one
  config file.

## Consequences

- A sixth subcommand. §04's on-disk format is untouched, which is the same
  test Revs G, H, L, O and P were taken as minor revisions on.
- Three budgets in §06: the extract's chrome at 800 kB, a 1k-note extract at
  8 MB, and open → readable at 500 ms from `file://`, scaled by
  `BUDGET_FACTOR` like the other three latencies. `size-limit` gains a fourth
  entry over `dist/extract/*`, raw rather than gzipped, because an extract is
  never served compressed.
- The binary grows by the second bundle, ~510 kB, against a 10 MB budget with
  six to spare.
- `api.ts` has two answers to every read. The doctrine test counts the offline
  branches against the fetch sites, so a route added without one fails there.
- No new dependency (rule 6). Base64 is thirty lines; the rest is `std`,
  `serde_json`, and a template filled in one pass.
