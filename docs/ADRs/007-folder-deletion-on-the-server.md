# ADR-007 — A folder deletion is one server operation, not a loop over notes

- **Status:** accepted, 2026-08-11
- **Affects:** §04 Rev P (`src/vault.rs`, `src/server.rs`, `app/src/core/api.ts`,
  `app/src/ui/Palette/`)

## Context

The app had no delete of any kind. `DELETE /api/note/{path}` shipped in P3 and
the only caller anywhere in the client is `store.svelte.ts`, retiring a conflict
copy after a merge. Nothing in the palette, no keybinding, no row affordance —
so the answer to "remove this" was Finder, which is the answer Rev O had just
finished removing for images.

The request that started this was for folders specifically. Two facts decide
most of the design:

1. **A folder is not a thing the vault stores.** `GET /api/tree` returns notes;
   `folderTree()` derives every folder in the INDEX from their paths. A folder
   row exists exactly while a note is under it, so "delete this folder" can only
   mean *trash every note under it*, with the row disappearing as a consequence.
2. **`trash()` is `.md`-only.** It goes through `resolve()`, which enforces
   `NOTE_EXT` — the single definition of "a note" that the tree, the write path
   and the watcher all share. It cannot name a PNG.

So the operation could plausibly have been built entirely in the client: it
already holds every note path, and `deleteNote` already exists. That option is
the one this ADR rejects.

## Decision

Add `DELETE /api/folder/{*path}`, which moves the directory into
`.register/trash/<stamp>/` with a single `rename`.

**Why not the client loop, which needs no new endpoint and no §04 revision:**

- **One deletion must be one bucket.** `trash()` was built so a deletion lands in
  its own `<stamp>` directory holding the note at its original vault path — that
  is what lets `next_ref` see the refs a deleted note used and never reissue
  them (§04 Rev F), and what makes a deletion restorable by moving something
  back. A loop claims a bucket per note, so one folder scatters across as many
  buckets as it held notes, with nothing recording that they were one act.
  Restoring becomes archaeology.
- **The images would be left behind.** Point 2 above: the loop physically cannot
  move them. It empties a folder of its notes and leaves `diagram.png` in a
  directory the INDEX now draws as gone. That is a worse outcome than no feature.
- **It is not atomic.** A loop that fails at note 7 of 12 leaves a half-deleted
  folder and no way to describe what happened. One `rename` either happened or
  did not.
- **N round trips**, on a folder that may hold hundreds of notes.

**Why not a recursive mode on `DELETE /api/note`.** It reads as the cheaper
change — same route, one flag — and it is the more expensive one: `resolve()`
would have to accept a path with no `.md`, and that gate is the thing keeping
the write surface and the read surface honest with each other. A directory
delete reachable from a URL whose name says "note" is also the wrong shape to
leave lying around.

**Removing non-notes does not reopen the read-only rule on `GET /api/file`.**
That rule exists so the vault cannot *acquire* a file its own tree will never
show — "a silent way to lose data inside your own vault", as `resolve`'s comment
puts it. Removal is the other direction, and it is precisely the direction where
leaving the file behind causes the inconsistency.

**Empty directories are removed**, innermost first, stopping at any direct child
of the root and at anything still holding a file. Without it the INDEX and the
filesystem disagree in the visible direction: the folder is gone from the app and
still in Finder. The root-child stop is what keeps `notes/` alive through its own
last deletion; the non-empty stop is `remove_dir`'s own refusal, so nothing in
this path can remove a file.

**The response is `{notes, files, bucket}`, not `204`.** The client confirms
against the notes the INDEX draws and cannot see the rest of the folder, so only
the server can say what actually left. The confirm shows the number the reader
can verify on screen; the notice afterwards reports the truth, and the two are
allowed to differ because that difference is the media.

## Alternatives considered

- **A trash browser / restore endpoint.** Recovery is currently "open
  `.register/trash/<stamp>/` in Finder", which the notice names. A restore path
  is a bigger feature than a delete and wants its own screen; parked.
- **`If-Match` on the folder delete.** A per-note etag does not describe a
  subtree, and inventing one for a directory would be a §04 format decision. The
  operation is reversible, which is what makes going without acceptable.
- **A context menu on the INDEX row**, for a mouse affordance. That is a new
  §02b component with its own state matrix. Instead `⌫` on a focused row arms
  the palette, and the palette carries `DELETE · NOTE` / `DELETE · FOLDER` for
  anyone not using the keyboard — no row changes at all.

## Consequences

- The tenth endpoint. §04's API table grows; the note format does not change,
  which is the same test Rev G, H, L and O were taken as minor revisions on.
- `.register/trash/<stamp>/` can now hold a directory rather than only a file.
  Nothing reads the trash except `next_ref`, which walks it for `.md` files at
  any depth and is unaffected.
- The counts in a notice can exceed the count in the confirm. That is intended
  and is the only way the reader learns an image went with the folder.
- No new dependency (rule 6). This is `std::fs` and one route.
