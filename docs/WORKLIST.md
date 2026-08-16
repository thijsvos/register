# Worklist

Derived from [`ROADMAP.md`](ROADMAP.md), which stays canonical. Delete this file
when it is empty.

**All 58 non-expansion entries have now been read in full**, not sorted by title.
That distinction matters: the first pass at this file guessed from titles and put
seven items in "ready" that their own entries rule out, and the one entry I did
open — the "flaky" watch test — turned out to be described wrongly, which is why
it had sat unfixed for weeks.

Three items are done and struck from the roadmap: setext headings, `register new
--vault`, and that watch test.

## I can do these now

No ruling needed. Ordered by what a failure would cost.

| # | Item | Why it is free of a decision |
|---|---|---|
| 1 | **A failed checkpoint says nothing at all**<br>`checkpoint()` returns a bool nobody surfaces, so a vault with `"checkpoints": true` and no git identity — every container — silently never commits. The entry says this half is *"worth having regardless"* of the identity question. | Silent failure of a feature you turned on. |
| 2 | **No guard on the chunk graph**<br>The bundler once hoisted `core/` into the editor chunk and had the shell import it statically — all of CodeMirror at boot, invisible to a budget that only weighs `shell-*.js`. A lint bans the static import; nothing inspects the built output. | The regression already happened once and the budget could not see it. |
| 6 | **§06's idle-RAM budget measures the process holding no notes**<br>It measures the Rust server, which forgets every file it reads, while the browser tab holds every body twice. The entry's own trigger is *measuring it* — the number then decides whether this is a wording fix or a real bound. | I can produce the measurement without changing anything that ships. |
| 7 | **Nothing stops the embed margin coming back**<br>A margin on a block widget puts CodeMirror's height map out and the caret with it. The e2e test catches it; nothing says why at the point somebody edits the CSS. `doctrine.test.ts` already greps that file. | The entry proposes the fix itself. |
| 8 | **The client validates a path the server owns**<br>`cleanFolder` mirrors `resolve_within` segment by segment, and a mirror can drift. The entry offers a cheap answer: one shared table of cases both sides are held to. | Hardening the path rules that a review already found holes in. |
| 9 | **§06's latency assertion inside vitest is load-sensitive**<br>A wall-clock `< 16 ms` assertion in a unit test, which every new test file makes likelier to fail. `budgets.spec.ts` already solved this for e2e with `BUDGET_FACTOR`. | The entry names the answer: a wall-clock budget belongs in the e2e suite. |
| 10 | **Two `register` processes can race**<br>The in-process write lock is enough for one server and nothing else. Two instances over one vault race on both writes and `create`'s free-name check. | An OS-level lock is an implementation choice, not a doctrine change. |

## Your call

Each carries a specific question. Two of them the roadmap already marks *"my
call"* — meaning yours — and are one line each.

| Item | The question |
|---|---|
| ⌘D is claimed twice | §08 P7 and §02b Screen 2 disagree about what ⌘D does. The entry says: *"My call on which; a one-line swap either way."* |
| The vault contract still describes the manual merge route | `scaffold.rs` tells agents to merge by hand. The entry says: *"My call; it is one line and a test update."* It is a §04 edit. |
| Frontmatter is shown in the editor | Folding it needs a §02 ruling on whether folding counts as hiding the source. |
| Renaming and moving anything | Two entries, one question: does the app rewrite the `[[wikilinks]]` and `![](src)` that point into what moved? |
| Nothing restores from the trash | Wants a §02b screen — a list of buckets, and an answer for a path whose home is gone. |
| A tag is not clickable | Filter the index, or seed ⌘K? §02b's matrix defines neither state. |
| `--signal` has nine consumers | The token's comment still says "status LED only" and has been false since P4. A ruling on what the accent is *for* settles all nine at once. |
| A theme change dirties the repo | `config.json` is tracked, so flipping to dark shows up in `git status`. Defensible either way. |
| The reading column is a third of an ultrawide | Elastic rails turn §02's frame dimensions from constants into functions of width. |
| The measure under-delivers by six characters | `68ch` renders 61.8ch because padding sits inside the cap. Needs a decision about which number §02 means. |
| §06 budgets no CSS | `size-limit` weighs JS only. Adding a CSS row is a §06 amendment. |
| SVG is not served | Sandbox CSP, `Content-Disposition`, or rasterise — three different answers. |
| An orphan image is invisible | An attachments view is a §02b screen, not a filter. |
| The confirm counts what the INDEX draws | Showing the true count means a round trip inside a keystroke. |
| A deletion has no `If-Match` | A per-note etag cannot describe a subtree; a tree revision is a bigger idea. |
| An unreadable note looks like an untitled one | Saying so in the tree is a §04 envelope change. |
| A titled note still needs a stencil | A NEW · NOTE row taking the query as its title is a §02b decision about what `new` means. |
| Screenshot baselines per screen | Needs a decision about which platform owns the baselines — almost certainly a container. |
| Cross-tab ref collision | Two tabs can both take `015`. Closing it wants a create-if-absent addition to §04. |
| Etag collision window | `mtime + len` is §04's; changing the scheme changes §04. |
| Loopback is read as "the owner" | On a shared host every uid gets full access over 127.0.0.1. The fix wants a Unix socket, which is a §04 API-surface change. |
| Any loopback origin is trusted | Narrowing it needs an explicit dev-origin flag. |
| A checkpoint sweeps the staging area | `git add -A` takes your part-staged work with it. |
| Slug folding is partial, not NFKD | Rust std has no Unicode normalisation, so this needs a crate — an ADR and your approval under rule 6. |

## Not mine, or not yet understood

| Item | Why |
|---|---|
| The released binaries are unsigned | Needs your Apple Developer certificate, or a decision to use GitHub artifact attestations and document the verification story. |
| Remote mode has no TLS | Deliberate. A tailnet or a reverse proxy is the answer; §12 lists an encrypted-remote milestone. |
| An image arriving after the first measure | Three fixes measured to change nothing. The next step is understanding CodeMirror's height map, not a fourth guess. |
| The fixture only covers what someone thought to break | Wants a real vault from a real user. |
| The crumb rule is unfalsifiable | Blocked on the header actually narrowing, which is a different entry. |

## Expansion (§12)

Ten rows — query views, kanban, graph, plugins, importers, co-editing, richer
sync, native shells, encrypted remote, richer editing. Not defects and not a
todo list; they are the shape of a v2.

