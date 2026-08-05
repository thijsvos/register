# Roadmap

Deferred ≠ declined (§12). Anything here may land once it passes three gates:
it fits the §04 vault contract (or bumps the major version with a documented
migration), it fits the §06 budgets or ships lazily, and it obeys §02. Process
is roadmap entry → ADR → milestone.

P11 seeds this file from §12's table. Until then it carries risks and ideas
parked during earlier phases, so they are recorded somewhere other than a commit
message.

## Parked during P2 (server core)

| Item | Why it is parked | Trigger |
|---|---|---|
| **Etag collision window** | §04 mandates `mtime + len`, so two different bodies of identical length written inside one filesystem mtime tick share an etag. Measured sub-microsecond on macOS/APFS, so it is not reachable in practice there; ext4's granularity is coarser. Changing the etag scheme would change §04. | A real collision, or a §04 revision. The client rule meanwhile: an equal etag on a `changed` frame must **not** be read as "no change". |
| **Cross-process write races** | `vault.rs` serialises writes with an in-process lock, which is sufficient because hard rule 5 routes every write through one process. Two `register` instances over one vault would still race. | Anyone runs two servers on one vault — or P12's remote mode makes that ordinary. |
| **Any loopback origin is trusted** | The origin guard allows `http://localhost:<any port>` so `pnpm dev` can proxy from vite. That grants the same authority to every other local web server. Narrowing it needs an explicit dev-origin flag. | P12, alongside token mode — the same conversation about who may talk to the server. |
| **No WebSocket keepalive** | `pump()` has no ping/pong and no send timeout, so a half-open connection is never detected. Harmless on loopback; it matters over a tailnet. | P12 remote mode. |
| **`If-Match: *`** | RFC 9110 defines the wildcard as "matches iff the resource exists". Unimplemented; no client sends it. | A second client, or a spec revision that asks for it. |
| **`cargo-audit` in CI** | Would have flagged RUSTSEC-2025-0068 (the unsound `serde_yml`) automatically rather than by hand during ADR-001. Cheap to add. | P10/P11 release engineering, where CI grows anyway. |

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
| **No guard on the chunk graph** | P6 made the lazy editor chunk share `core/` with the shell, and the bundler answered by hoisting `core/` into the *editor* chunk and having the shell import it statically — all of CodeMirror at boot, invisible to a budget that only weighs `shell-*.js`. Fixed by naming a `core` chunk, and `doctrine.test.ts` now bans a static editor import from the shell side; nothing yet inspects the built output. | P10/P11 release engineering, where a `dist/` assertion belongs with the other CI size checks. |
