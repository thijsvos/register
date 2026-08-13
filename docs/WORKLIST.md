# Worklist

Derived from [`ROADMAP.md`](ROADMAP.md), which stays canonical — this is a
sequencing view, not a second source of truth. When an item is done the roadmap
entry is what gets struck through; the line here is just crossed off. Delete this
file when it is empty.

79 open roadmap entries. Ten of them are §12 expansion rows rather than
defects, and four more are already-settled records the parser cannot tell apart
from work. What is left is below, in the order I would take it.

## Ready — small, and in the way daily

No ruling needed. Three, not ten — the first pass at this table sorted on titles
and put seven items here that their own roadmap entries rule out. Reading the
entries is the only way to tell: "Today is UTC" *reads* like a bug and is written
down as doctrine that is explicitly not mine to change.

| # | Item | Why it matters |
|---|---|---|
| ~~1~~ | ~~The outline ignores setext headings~~ — **done** | A `Title` over `=====` is a heading in CommonMark. The editor does not style it and the outline does not list it. |
| 2 | `register new` only works inside the vault | No `--vault` flag, so an agent has to `cd` first. The roadmap calls it one line. |
| 3 | `register serve` has no `--open` | Every run prints a URL you then click. |

## Needs your ruling first

Every one of these has a decision in front of the code. I can put the options and
a recommendation in front of you, but choosing is yours.

| Item | The question |
|---|---|
| The scheme has no third button | A §02b decision. |
| Frontmatter is shown in the editor | Hiding it waits on a §02 ruling: does folding count as hiding the source? |
| The reading column is a third of an ultrawide | Widening the measure is a §02 change. |
| 1.5× is forbidden by the pixel grid, and 2× overshoots | A §02 type decision. |
| Nothing renames or moves a folder | Needs a decision on whether the app rewrites links into what moved. |
| Nothing restores from the trash | Wants a §02b screen, so it is a design call. |
| A folder is deletable but not renamable or movable | Same decision as above. |
| SVG is not served | Needs a decision on what a safe SVG path looks like. |
| An orphan image is invisible | Wants an attachments view, which is a §02b screen. |
| `![[embed]]` is not read | Not in §04; belongs with Importers. |
| "Today" is UTC, not local | §02 rules timestamps are UTC everywhere in the chrome. The roadmap says outright this is "a doctrine change rather than a bug fix, and not mine to make". |
| A changed image does not repaint | The cheap half — busting one `<img>` cache — is client-side. The honest half is whether media belongs in the watcher, which touches the definition the tree, the API and the watcher share. |
| A ticked task vanishes with no undo | §02b Screen 5 is defined as *open* tasks, so the row leaving is the spec working. Undo means changing what the screen is. |
| A `[link](other.md)` still does nothing | "Which of the two link syntaxes opens a note" is a §04 question. |
| A link to a missing file stays dressed until something embeds it | A `HEAD` per reference costs a request per link on every note opened; the alternative is listing media in the tree. |
| A tag is not clickable | Filtering the index by tag is a §02b state the matrix does not define yet. |
| An empty top-level folder is left on disk | Telling *your* top-level folder from §04's layout means naming the layout in code, which the format does not do anywhere else. |

## Not mine to do

| Item | Why |
|---|---|
| E2E-encrypted remote | Post-v1 expansion. |
| The released binaries are unsigned | Needs your Apple Developer certificate and a notarisation secret. |
| Remote mode has no TLS | Deliberate — a reverse proxy or tailnet is the answer. |

## Everything else, by where it was parked

Real, documented, and deliberately waiting — each carries its own trigger in the
roadmap. Most are hardening (races, budgets, fixtures) or §12 expansion.


**Decided after v0.3.1 (first use in anger)**

- The index could only be reached with three Tab presses — *A §02b revision that draws entry into a pane, which should also settle whether the inspector's panes deserve…*
- The WATCHER lamp is red when live, and red usually means broken — *More than one person reading the lamp as an alarm. One report is a convention mismatch; a pattern is a design…*

**Decided after v0.3.2 (a week of real use)**

- A daily log is knowledge, and there is one of them every day — *Anyone wanting to browse the journal by date. The honest answer then is not to re-list them — it is a dated…*

**Decided after v0.4.1 (an ultrawide monitor)**

- The GIT field could never say anything in a container — *Wanting GIT to work from the published image too — the honest options are a second published tag, or…*
- The GIT field did not speak git — *A field that needs to distinguish *behind* from *ahead*, or to name a remote — both are more envelope, and…*
- Checkpoints cannot commit from the container even now — *Anyone enabling checkpoints in the container. The fix is either passing an identity through compose or making…*
- The frame rendered at exactly one size on every display — *A display class the two stops do not serve — 5K/8K, where 3× is a one-word addition, or the 2000–2500 px…*

**Decided after v0.4.1 (somebody else tried to install it)**

- `latest` is now published — *Anyone treating `latest` as stable in automation. The versioned tags are what to depend on and the README…*

**Parked after the folder tree**

- The crumb's "trail gives way, the note does not" rule is unfalsifiable in practice — *The overflow entry above being fixed, which would let the header actually narrow — at which point the outcome…*

**Parked during P11 (QA hardening)**

- No §02b screenshot baselines — *A decision about where baselines are generated — almost certainly a container, so one platform owns them.*

**Parked during P12 (checkpoints + remote mode)**

- A checkpoint sweeps the staging area — *Anyone using the index deliberately in a checkpointed vault.*
- `git status` runs on every tree fetch — *A vault where `git status` is slow enough to notice.*

**Parked during P13 (§02b Screen 4)**

- The merge table has no j/k traversal — *A §02b revision that draws keyboard movement for a two-column surface.*
- No "take every line from one side" — *A real merge long enough that the picker is the bottleneck.*
- The diff is line-level, not word-level — *Someone merging prose rather than structure.*
- `--signal` has a ninth consumer — *A §02 ruling on what the accent is *for*, which would settle all nine at once rather than the newest.*
- The vault contract still describes the manual route — *My call; it is one line and a test update.*
- A conflict of a conflict is refused, not merged — *Anyone hitting it twice in a row.*

**Parked during P14 (the compatibility fixture)**

- An unreadable note is indistinguishable from an untitled one — *A §02b state for what an unreadable note looks like in the index — which would settle the envelope question…*
- The fixture only covers what someone thought to break — *A real vault from a real user, or any bug whose reproduction is a file rather than a sequence.*
- §06's latency assertions inside vitest are load-sensitive — *The first time it fails CI. The cheapest answer is probably that a wall-clock budget belongs in the e2e…*
- §06's idle-RAM budget measures the process that holds no notes — *Measuring it. Chromium's CDP gives `JSHeapUsedSize` without touching what ships; the number then decides…*

**Parked during P2 (server core)**

- Etag collision window — *A real collision, or a §04 revision. The client rule meanwhile: an equal etag on a `changed` frame must…*
- Cross-process write races — *Anyone runs two servers on one vault — or P12's remote mode makes that ordinary.*
- Any loopback origin is trusted — *P12, alongside token mode — the same conversation about who may talk to the server.*
- No WebSocket keepalive — *P12 remote mode.*
- `If-Match: *` — *A second client, or a spec revision that asks for it.*
- Loopback is read as "the owner", and on a shared host it is not — *Anyone running this on a shared host — or a §04 revision that adds a socket transport.*
- ~~`the_servers_own_atomic_write_reports_one_change_not_a_temp_file` is flaky~~ — **done** — *The first time it fails a pull request that is otherwise green — or sooner, since the repository is now…*

**Parked during P3 (client store)**

- Cross-tab ref collision — *Multi-tab or multi-agent creation proving it out; would want a create-if-absent addition to §04.*

**Parked during P6 (search, backlinks, tags)**

- No guard on the chunk graph (P6) — *P10/P11 release engineering, where a `dist/` assertion belongs with the other CI size checks.*

**Parked during P7 (daily, tasks, templates)**

- ⌘D is claimed twice — *My call on which; a one-line swap either way.*

**Parked during P8 (init + agent contract)**

- Slug folding is partial, not NFKD — *A vault in a non-Latin script, or a Unicode crate arriving for another reason.*
- Two `register` processes can still race — *The same trigger as that entry — anyone running two instances over one vault.*

**Parked during P9 (BYOF + font themes)**

- A theme change dirties the repo — *A shared vault, or anyone irritated by a dirty status after touching settings.*
- BYOF is one face, not a family — *Anyone loading a licensed face and finding bold looks wrong.*

**Parked during deletion (§04 Rev P)**

- A deletion has no `If-Match` — *Wanting the confirm to be a real optimistic lock. The honest shape is probably a tree revision, which is a…*
- The confirm counts what the INDEX draws, which is not what leaves — *The gap being surprising in practice rather than in theory. A `GET` on the folder route returning the tally…*

**Parked during folder creation (§04 Rev P)**

- A titled note still needs a stencil — *Anyone deleting their stencils. The fix is a NEW · NOTE row that takes the query as its title, which is a…*
- The client validates a path the server owns — *The two disagreeing. The honest fix is the server answering "where would this go" before the write, which is…*

**Parked during the embed caret fix**

- An image that arrives *after* the first measure leaves the caret a line out — *A reader on a slow link, or an image big enough to decode late. Reproduce with Playwright's `page.route`…*
- Nothing stops a margin coming back — *The next person adding vertical space to a block widget.*

**Parked during the media surface (§04 Rev O)**

- The start-to-editable budget runs close to its limit on a loaded machine — *It failing on an idle machine, which would make it a real regression rather than load. Until then the honest…*

**Parked during the plate scale (§02 Rev K)**

- §06 budgets no JS-free asset — *Adding a third `size-limit` entry for `dist/assets/*.css`. That is a §06 amendment, so it needs a row in the…*
- The measure under-delivers by six characters — *Fixing it deliberately, which is a one-line `calc(var(--measure) + 48px)` per consumer or a `content-box`…*
- A pinned scale arrives after first paint — *It becoming visible enough to complain about. The fix is the server stamping the class on `index.html` as it…*
- `zoom` × `dvh` is proven in one engine — *Adding Firefox and WebKit projects to `playwright.config.ts`, or the first report of a clipped status bar…*

**Post-v1 expansion (§12, seeded by P11)**

- Deferred feature — *Prerequisite / trigger*
- Query & table views ("databases") — *Query-grammar ADR; v1 corpus/store stable.*
- Kanban / boards — *The query engine above.*
- Graph view — *Demand-driven; lazy chunk within budget.*
- Plugin system — *API freeze + a security-model ADR.*
- Realtime co-editing — *True multi-writer demand.*
- Built-in richer sync — *P12 shipped; user pull.*
- Importers — *None — the best first post-v1 milestone.*
- Native shells / mobile ergonomics — *PWA ergonomics measured insufficient.*
