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

| Item | Why it is parked | Trigger |
|---|---|---|
| **Refs are reused after a deletion** | §04 says "ref = highest **existing** + 1", so deleting the highest note makes the next ref fall back to just above the highest survivor — seed 000 and 003, delete 003, and the next note takes 001. A wikilink written as `[[001]]` then resolves to a different note. Implemented faithfully, with a test asserting exactly this; changing it means changing §04. | A decision to make refs permanently unique, which is a §04 revision. |
| **A conflict copy is an ordinary note** | `*.conflict-<ts>.md` lands in the tree indistinguishable from any other note, and the only thing announcing it is a status-bar line that the next successful save clears. §02b Screen 4 is the real resolution surface. | The phase that builds §02b Screen 4. |
| **VAULT and GIT are permanently dashed** | §02b Screen 1's status bar shows `VAULT ~/vault`, but §04's API table is complete and exposes neither the vault path nor git state. Showing either would mean a sixth endpoint, i.e. a §04 change. | A §04 revision, or P12 for git. |
| **`/api/tree` and event frames are cast, not validated** | `as Entry[]` and `as VaultEvent` trust the server completely. Both ends are ours and the server is typed, so a mismatch is a build-time bug rather than a runtime one — but a malformed frame currently becomes `undefined` deep in the store rather than a clear error. | A schema-validation ADR, or the first time a frame shape changes. |
| **Cross-tab ref races** | Two browser tabs computing `nextRef` against their own trees can pick the same ref. `create()` confirms the name is free before writing, which closes the window to milliseconds but does not eliminate it, because §04's PUT has no create-if-absent mode. | Multi-tab use proving it out, or an `If-None-Match` addition to §04. |
