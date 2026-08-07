# REGISTER

A file-native second brain. Your entire knowledge base is a folder of plain
markdown files; a single small Rust binary (`register serve ~/vault`) renders it
as a fast, keyboard-first, terminal-grade UI on localhost. Humans edit through
the UI, agents edit the files directly, and a watcher keeps both views identical
within 100 ms.

- **Files are the truth.** No database, no hidden state. Every capability of the
  UI is a plain file edit; derived data (backlinks, tasks, index) is computed,
  never stored.
- **Agent-compatible by construction.** `register init` writes a `CLAUDE.md`
  agent contract into every vault, so Claude Code works with it out of the box.
- **Instrument, not lounge.** Engineering-grade monochrome, one typeface family
  in two working weights, 1px hairlines, a single signal color for live status.
  Latency is a material:
  16 ms interactions, sub-100 ms agent-edit-to-paint, enforced in CI.

V1 ships five things to instrument grade — notes, links, tags, tasks, search —
and stages everything else (§12). The full contract is in **`SPEC.html`**.

![The editor, with the index, tag meters, outline and backlinks](docs/screenshot.png)

## The thesis

Every note-taking app eventually asks you to trust its database. REGISTER does
not have one. Your notes are the files; everything else — backlinks, tags, the
task list, the search index — is computed on read and thrown away.

That is not asceticism, it is what makes an agent a first-class editor. Claude
Code does not need an API, a plugin or a sync protocol to work with your vault;
it needs a folder and a contract, and `register init` writes the contract into
the folder. A human edits through the UI, an agent edits the files, and a
watcher keeps both views identical inside 100 ms. Neither side is a guest.

Nothing is ever hard-deleted, either. A removed note moves to `.register/trash/`,
which the server still counts when it hands out the next reference number — so a
`[[003]]` written last month can never quietly start pointing at different prose.
That is the whole of the vault's bookkeeping.

The design follows from the same idea. If files are the truth, the interface is
an instrument for reading them, not a place things live — so it is monochrome,
hairlined, keyboard-first, and free of animation that would cost latency for
decoration.

## Budgets

Not aspirations. Every one is asserted in CI. Where a number is given it is what
the last commit produced on an M-series laptop; `asserted` means the budget is
checked on every run but the figure is the machine's rather than the product's.

The three latency budgets are asserted at 2.5× under `CI`: a shared two-vCPU
runner measured ~2.4× slower across all three at once, which is a CPU ratio and
not a regression. The raw figure is printed either way, and `BUDGET_FACTOR=1`
runs the promise as written on any machine.

| Budget | Limit | Measured | Enforced by |
|---|---|---|---|
| Release binary | ≤ 10 MB | 3.04 MB macOS arm64 · 3.65 MB linux x64, the largest | `release.yml` per platform |
| Shell JS (initial) | ≤ 60 kB gz | 37.45 kB | `size-limit` |
| Editor chunk (lazy) | ≤ 150 kB gz | 101.36 kB | `size-limit` |
| Idle RAM, 1k notes | ≤ 50 MB | asserted | Playwright + `ps` |
| Agent edit → visible | ≤ 100 ms | asserted | Playwright, real file write |
| Document switch | < 16 ms | asserted | status-bar RENDER + Playwright |
| Server start → editable | < 500 ms | asserted | Playwright |
| Repository size | < 5 MB | asserted | CI `git count-objects` |

If a change breaks a budget, the change shrinks. Not the budget.

## Running it

Two modes. Native is the primary one; the container exists for a home server or
a tailnet, where you want the UI on every device and the vault in one folder.

### Native

```sh
register init ~/vault --git   # scaffold: folders, CLAUDE.md, .gitignore, git repo
register serve ~/vault        # UI on http://127.0.0.1:7777
```

Then, in another terminal, point an agent at the same folder:

```sh
cd ~/vault && claude
```

Nothing syncs between them. The agent writes files; the app notices, within
100 ms. See [`docs/agents.md`](docs/agents.md).

`register serve` binds to loopback unless told otherwise. `register new "Title"`
creates a conforming note from inside a vault and prints its path.

**Installing.** Until the first tagged release, build it yourself:

```sh
cd app && pnpm build          # the UI is embedded in the binary
cd .. && cargo install --path . --force
```

`--force` is belt and braces. Cargo 1.97 does replace an installed binary whose
source changed even without it — measured — but it has not always, the message
it prints when it declines is easy to miss, and the failure it prevents is the
expensive one: a fix that appears not to work because you are still running last
week's binary.

**Working on the UI?** The binary carries the UI inside it, so every change
otherwise needs that full reinstall — and a stale binary looks exactly like a
fix that did not work. `--assets` skips it:

```sh
register serve ~/vault --assets app/dist    # from the repo root
```

Now `cd app && pnpm build` is enough; reload the browser and the change is
there. The server says so at startup, because this is the one mode where what
you are looking at is not what the binary would ship. For live reload while
typing, `pnpm dev` is still faster — this is for seeing the *built* UI without
paying for a reinstall.

From v1.0 onward: prebuilt binaries on the GitHub release page for macOS
(arm64/x64), Linux (x64/arm64, musl) and Windows x64. Until then, the two
commands above are the whole story.

Two install commands you will not find here, both deliberately.

**No `cargo install --git`.** `app/dist/` is gitignored, so the checkout cargo
makes for itself has no UI to embed — and that build *succeeds*. It starts, it
serves `/api`, and it answers every page request with `no UI bundled; run cd app
&& pnpm build`: a working server behind a blank 404, which is a worse failure
than not compiling at all. Build the UI first and install from the path.

**No `cargo install register-notes`.** The name is not claimed on crates.io, and
printing an install command for a package someone else could publish is how you
get a supply-chain incident with your own README as the delivery mechanism.

### Container

```sh
REGISTER_UID=$(id -u) REGISTER_GID=$(id -g) VAULT_PATH=~/vault \
  docker compose -f deploy/docker-compose.yml up -d --build
```

**`--build` is not optional when you are building from source.** Without it,
compose reuses whatever image it built last time — so your changes are simply
absent, and the symptom is identical to the code not working. It cost an
investigation here before it was written down. Drop the flag only when you are
running a published image you have not modified.

Serves on `http://localhost:7777` against the folder you mounted. The image is
three stages down to `scratch`, so it is the binary and nothing else — no shell,
no package manager, **3.65 MB** on amd64 — which is what `release.yml` publishes,
since it builds on an x64 runner. Build it on an arm64 machine and you get
3.25 MB. The image *is* the binary; there is nothing else in it to account for
the difference. Every MB on this page is 1024², the unit `release.yml` measures
the budget in.

The live-reload works through the bind mount: edit a note on the host and the
watcher inside the container reports it in about 15 ms, so an agent running on
your machine and the UI in the container stay in step.

The compose file publishes on `127.0.0.1` only, so out of the box this reaches
the machine it runs on and nowhere else. Three things before you widen it:

- The container binds `0.0.0.0` because a published port needs it, not because
  the server is meant to be reachable from a network. The Origin and Host guards
  still hold, and `/api/reveal` refuses outright on a non-loopback bind — but
  putting this on a network is a decision. Behind Tailscale is the intended
  shape.
- Widening the `ports` line means adding a token in the same edit. The container
  runs with `--allow-tokenless-network`, which is safe only because compose
  publishes to `127.0.0.1`; a browser reaching it by the host's LAN address gets
  **403** from the Host guard, but that guard is a browser-integrity check and
  any non-browser client simply sets the header. Give it a real credential:
  `command: ["--token-file", "/vault/.register/token"]` in the compose file,
  appended to the image ENTRYPOINT.
- Agents still run on the **host**, against the same mounted folder. The
  container only serves the UI.

Images are published to `ghcr.io/thijsvos/register` on tags, addressable by version
only — there is no `latest`, deliberately, because nothing should depend on a
tag that moves under it.

## Using it

Everything is reachable from the keyboard, and every control on screen prints its
own key — so this table is a convenience, not a manual.

| Key | Does |
|---|---|
| `⌘K` / `Ctrl-K` | Command palette — full-text search, commands, templates |
| `⌘D` / `Ctrl-D` | TODAY — every open task in the vault, grouped by note |
| `G` `D` | The daily log for today's date |
| `G` `I` | The inbox, note `000` |
| `G` `T` | TODAY, the chord form |
| `N` | New note |
| `I` | Switch light ↔ dark — kept in the vault, same as Settings |
| `[` · `]` | Toggle the index · the inspector |
| `Esc` | Leave the editor — the caret vanishing is the mode indicator |
| `↵` | Back into the editor |
| `↑` `↓` · `j` `k` | Walk a list: index, outline, backlinks, TODAY |
| `↑` `↓` · `Tab` | Move within the palette — `j` and `k` are letters while you are typing |

⌘K is the whole navigation surface. It runs real full-text search over the note
bodies rather than filtering a fixed list; it matches commands as a subsequence,
so `tgi` finds TOGGLE INSPECTOR; and it lists everything in `templates/` under
NEW FROM TEMPLATE, where whatever you have typed becomes the new note's title.

**The daily log.** `G D` opens `daily/YYYY-MM-DD.md`, cutting it from
`templates/daily.md` the first time each day and opening it every time after. The
date is UTC, like every other timestamp in the chrome.

**TODAY** is an aggregate that stores nothing. It re-derives every `- [ ]` in the
vault, groups them under the note each came from, and ticking one writes through
to that line in that file — the count in the header is the vault's, not a
list's.

**The inspector** is the same trick applied to one note: properties, outline,
backlinks and tag counts, all recomputed from the buffer as you type. The
backlinks are `[[wikilinks]]` inverted; following one to a note that does not
exist creates it.

**Settings** (`GO · SETTINGS / BYOF` in ⌘K) holds three things, none of them in
browser storage: the scheme (light, dark, or press the lit one again to follow
the OS — `I` and the INV key do the same thing and are kept the same way) and the body face (Commit, or Server Mono as a "teletype" theme), both
written to `.register/config.json`; and BYOF, whose font bytes go to
`.register/fonts/` — a directory `register init --git` adds to `.gitignore`,
because a licensed face is yours and not the repository's. See below.


## Remote access, and history

Both are off by default and neither adds an account, a service or any telemetry.

### Git checkpoints

If your vault is a git repository of its own, REGISTER can commit it for you
after it has been quiet for 90 seconds:

```jsonc
// .register/config.json
{ "checkpoints": true }
```

Commits are `checkpoint: 14:07Z`. It **never pushes** — that is a decision about
somebody else's repository — and it never commits a folder that merely *contains*
your vault, so a vault nested inside a larger repo checkpoints itself or not at
all. Nothing changes? Nothing is committed. The status bar's GIT field shows
`CLEAN`, `DIRTY`, or `N AHEAD` when there is an upstream to be ahead of.

Turn it off by deleting the flag. Your history is ordinary git: `git log`,
`git revert`, `git checkout` all work, because there was never anything else.

Not in the container, though. The image is `FROM scratch` and has no git binary,
so checkpoints cannot run there and the status bar's GIT field stays dashed even
for a vault that is a repository. Run `register serve` natively if you want them.

### Remote mode

```sh
openssl rand -hex 24 > ~/.register-token
register serve ~/vault --host 0.0.0.0 --token-file ~/.register-token
```

`--token-file` rather than `--token`, because a command line is public: `ps`
shows it to every other user on the machine. `REGISTER_TOKEN` in the environment
works too and is nearly as good — on Linux `/proc/<pid>/environ` is readable by
the same user, but not by others. `--token` still exists for a throwaway, and
the three are mutually exclusive.

Then open `http://<host>:7777/?token=<the token>` once. The token is stored as
an HttpOnly cookie, which is what carries it into the WebSocket — that API
cannot send an `Authorization` header, so a bearer-only scheme would leave live
reload either unauthenticated or unreachable. Scripts can use
`Authorization: Bearer <token>` instead.

The page then redirects to itself without the token, so the secret does not sit
in the address bar, in history, in a bookmark, or in the `Referer` of every link
you later click. The WebSocket is exempt: it cannot follow a redirect, and
`?token=` is how it authenticates before any cookie exists.

Binding a real interface with no token is **refused at startup**, because the
origin guard alone does not cover it: the `Host` header it checks is chosen by
the client, which stops a browser being rebound onto your loopback but stops
nothing that speaks HTTP directly. `--allow-tokenless-network` overrides the
refusal when something else already limits who can reach the port.

**Localhost stays tokenless.** A request that reached 127.0.0.1 came from the
machine the vault is on, where the files are readable anyway.

**Behind Tailscale is the intended shape** (§07). Put the machine on your
tailnet and bind to its tailnet address rather than to the whole world:

```sh
register serve ~/vault --host "$(tailscale ip -4)" --token "$(openssl rand -hex 24)"
```

Every device you own reaches it; nothing else can route to it at all. The token
is then a second lock rather than the only one. There is no TLS here — a tailnet
is already encrypted, and terminating TLS is your reverse proxy's job if you put
one in front.

No accounts. No user table. No telemetry. The token is a string you chose,
compared in constant time, and forgotten when the process exits.

## Contributing

Under construction with Claude Code, phase by phase per `SPEC.html` §08. Read the
spec end to end first, then `CLAUDE.md`; `register-prototype.html` is the visual
+ interaction reference.

```sh
cargo run -- health                  # server toolchain
cargo run -- serve ./devvault        # server, with the UI built into it
cd app && pnpm install && pnpm dev   # UI on :5173, /api proxied to :7777
```

`pnpm dev` serves the shell only. It proxies `/api` to a `register serve` on
7777, so leave one running in another terminal or the page boots with an empty
index and a dead status bar.

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the v1 scope fence, the
park-and-promote process, and what "green" means.

## Fonts and licensing

One family does the reading — Commit Mono at 400 and 700, which is what §02
means by "one typeface family in two working weights". The other two are not a
second body family: one draws the 11px micro layer, the other is a body theme
you have to go and choose. Three faces ship in this repository, all **SIL OFL
1.1**, each with its `OFL.txt` beside it:

| Face | Role |
|---|---|
| **Commit Mono** | default UI and body |
| **Departure Mono** | the micro layer — labels, status bar, on an 11px pixel grid |
| **Server Mono** | the alternate "teletype" body theme |

**Berkeley Mono / TX-02 is commercial and is never bundled.** U.S. Graphics
states its licences are not compatible with open-source apps and generally
disallows embedding in editors. It sits first in the font stack and resolves to
nothing unless *you* own it — Settings → BYOF loads your licensed file from your
own disk into your own vault, under `.register/fonts/`, which `register init
--git` puts in `.gitignore`. The bytes never leave your machine and are never
committed. (Not legal advice; read the licences.)

## License
MIT (code) · SIL OFL 1.1 (bundled fonts).
