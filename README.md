# REGISTER

A file-native second brain. Your knowledge base is a folder of plain markdown
files; one small Rust binary renders it as a fast, keyboard-first, terminal-grade
UI on localhost. You edit through the UI, agents edit the files, and a watcher
keeps both views identical within 100 ms.

- **Files are the truth.** No database, no hidden state. Backlinks, tags, tasks
  and the search index are computed on read and thrown away.
- **Agents are first-class.** Every vault carries a `CLAUDE.md` contract, so
  Claude Code works with it out of the box — no API, no plugin, no sync.
- **An instrument, not a lounge.** Monochrome, hairlines, one signal colour, zero
  animation. Latency is a material and the budgets are asserted in CI.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
  <img alt="The editor: index and tag meters on the left, a note with headings, wikilinks and inline code in the middle, outline and backlinks on the right, and the status bar reading GIT MAIN" src="docs/screenshot.png">
</picture>

<sup>Both themes, because dark is *tuned per surface* rather than inverted — the
picture follows whichever one you read GitHub in.</sup>

## Run it

```sh
docker run -d --name register -p 127.0.0.1:7777:7777 \
  -v ~/vault:/vault ghcr.io/thijsvos/register:latest
```

Open <http://localhost:7777>. That is the whole of setup.

`~/vault` does not have to exist. Pointing the app at an empty or missing folder
scaffolds a vault into it and says what it wrote; pointing it at a folder that
already holds markdown changes nothing. Your notes are plain files on your own
disk — delete the container and they are still there.

On Linux add `--user $(id -u):$(id -g)`, or every note ends up owned by uid 1000.

**Prebuilt binaries** for macOS, Linux and Windows are on the
[releases page](https://github.com/thijsvos/register/releases) if you would
rather not use Docker:

```sh
register serve ~/vault        # UI on http://127.0.0.1:7777
```

Compose, building from source, and the container's internals:
[`docs/install.md`](docs/install.md).

## Using it

Everything is reachable from the keyboard, and every control prints its own key —
so this table is a convenience, not a manual.

| Key | Does |
|---|---|
| `⌘K` / `Ctrl-K` | Command palette — search, commands, templates |
| `⌘D` | TODAY — every open task in the vault, grouped by note |
| `G` `D` · `G` `I` | The daily log · the inbox, note `000` |
| `N` · `I` | New note · switch light ↔ dark |
| `[` · `]` | Toggle the index · the inspector |
| `Esc` · `↵` | Leave the editor · go back into it |
| `↑` `↓` · `j` `k` | Walk a list: index, outline, backlinks, TODAY |
| `→` `←` · `l` `h` | Open and fold a folder in the index |
| `⌫` | On an index row: delete that note or folder — it asks first |

**⌘K is the whole navigation surface.** Real full-text search over note bodies,
not a filter over a fixed list; commands match as a subsequence, so `tgi` finds
TOGGLE INSPECTOR; and everything in `templates/` is offered under NEW FROM
TEMPLATE, where whatever you have typed becomes the new note's title.

**TODAY and the inspector store nothing.** TODAY re-derives every `- [ ]` in the
vault and ticking one writes through to that line in that file. The inspector
does the same for one note — properties, outline, backlinks, tags — recomputed
from the buffer as you type. Following a `[[wikilink]]` to a note that does not
exist creates it.

**Nothing is ever hard-deleted.** `⌫` on an index row asks a single question,
then moves the files to `.register/trash/<timestamp>/` keeping the paths they
had, so putting them back is one `mv`. A folder takes everything under it,
images and PDFs included. Trashed notes still count when the server hands out the
next reference number, so a `[[003]]` written last month can never quietly start
pointing at different prose.

**Settings** (`GO · SETTINGS` in ⌘K) keeps the scheme and the body face in
`.register/config.json`, and your own licensed font in `.register/fonts/` —
nothing in browser storage, because the vault is the only state there is.

## Agents

Point one at the same folder and leave it running:

```sh
cd ~/vault && claude
```

Nothing syncs. The agent writes files, the app notices within 100 ms, and neither
side is a guest. The contract every vault carries is what makes this work without
an integration — see [`docs/agents.md`](docs/agents.md).

## What it promises

Budgets, not aspirations: each is asserted on every CI run, and a change that
breaks one gets smaller — the budget does not.

| Budget | Limit | Measured |
|---|---|---|
| Release binary | ≤ 10 MB | 3.3–4.3 MB depending on platform |
| Shell JS (initial) | ≤ 60 kB gz | 43.6 kB |
| Editor chunk (lazy) | ≤ 150 kB gz | 102.2 kB |
| Agent edit → visible | ≤ 100 ms | asserted, real file write |
| Server start → editable | < 500 ms | asserted |

Idle RAM on a 1k-note vault, document-switch time and repository size are held
the same way. The full table and the reasoning are in `SPEC.html` §06.

## Remote access, and history

Off by default, and neither adds an account or any telemetry. REGISTER can commit
your vault for you if it is a git repository, and can serve beyond localhost
behind a token — Tailscale is the intended shape. Both in
[`docs/remote.md`](docs/remote.md).

## More

- **[`SPEC.html`](SPEC.html)** — the contract. Vault format, design system,
  screens, budgets, phases. Everything here is downstream of it.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — scope fence, how ideas get parked
  and promoted, what "green" means.
- **[`docs/ROADMAP.md`](docs/ROADMAP.md)** — everything deliberately not built
  yet, with the trigger that would change that.
- **[`docs/ADRs/`](docs/ADRs)** — decisions that needed an argument.

Built with Claude Code, phase by phase, against `SPEC.html` §08.

## Fonts

Three faces ship here, all **SIL OFL 1.1** with their `OFL.txt` beside them:
**Commit Mono** (UI and body), **Departure Mono** (the 11px micro layer) and
**Server Mono** (an alternate "teletype" body theme).

**Berkeley Mono / TX-02 is commercial and is never bundled.** It sits first in
the stack and resolves to nothing unless *you* own it; Settings → BYOF loads your
licensed file from your own disk into your own vault, which `register init --git`
puts in `.gitignore`. The bytes never leave your machine. (Not legal advice; read
the licences.)

## License

MIT (code) · SIL OFL 1.1 (bundled fonts).
