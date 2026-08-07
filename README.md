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
- **Instrument, not lounge.** Engineering-grade monochrome, one typeface family,
  1px hairlines, a single signal color for live status. Latency is a material:
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

The design follows from the same idea. If files are the truth, the interface is
an instrument for reading them, not a place things live — so it is monochrome,
hairlined, keyboard-first, and free of animation that would cost latency for
decoration.

## Budgets

Not aspirations. Every one is asserted in CI, and the measured figure is what
the last commit actually produced.

| Budget | Limit | Measured | Enforced by |
|---|---|---|---|
| Release binary | ≤ 10 MB | 2.96 MB | `release.yml` per platform |
| Shell JS (initial) | ≤ 60 kB gz | 37.3 kB | `size-limit` |
| Editor chunk (lazy) | ≤ 150 kB gz | 101.3 kB | `size-limit` |
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

The `--force` matters: without it `cargo install` silently does nothing when the
version has not changed, and you keep running the binary you built last time.

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
(arm64/x64), Linux (x64/arm64, musl) and Windows x64. Until then, and from
source at any time:

```sh
cargo install --git https://github.com/thijsvos/register --locked
```

There is deliberately no `cargo install register-notes` line to copy: the name
is not claimed on crates.io, and printing an install command for a package
someone else could publish is how you get a supply-chain incident with your own
README as the delivery mechanism.

### Container

```sh
VAULT_PATH=~/vault docker compose -f deploy/docker-compose.yml up -d --build
```

**`--build` is not optional when you are building from source.** Without it,
compose reuses whatever image it built last time — so your changes are simply
absent, and the symptom is identical to the code not working. It cost an
investigation here before it was written down. Drop the flag only when you are
running a published image you have not modified.

Serves on `http://localhost:7777` against the folder you mounted. The image is
three stages down to `scratch`, so it is the binary and nothing else — no shell,
no package manager, **3.28 MB**.

The live-reload works through the bind mount: edit a note on the host and the
watcher inside the container reports it in about 15 ms, so an agent running on
your machine and the UI in the container stay in step.

Two things worth knowing before you publish that port:

- The container binds `0.0.0.0` because a published port needs it, not because
  the server is meant to be reachable from a network. The Origin and Host guards
  still hold, and `/api/reveal` refuses outright on a non-loopback bind — but
  putting this on a network is a decision. Behind Tailscale is the intended
  shape.
- Which is enforced, not just advised: `http://localhost:7777` works, and the
  same container reached by the host's LAN address answers **403**. The Host
  guard refuses a non-loopback name from anyone who has not presented a token,
  so making this genuinely reachable means setting one — see below.
- Agents still run on the **host**, against the same mounted folder. The
  container only serves the UI.

Images are published to `ghcr.io/thijsvos/register` on tags, addressable by version
only — there is no `latest`, deliberately, because nothing should depend on a
tag that moves under it.

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

### Remote mode

```sh
register serve ~/vault --host 0.0.0.0 --token "$(openssl rand -hex 24)"
```

Then open `http://<host>:7777/?token=<the token>` once. The token is stored as
an HttpOnly cookie, which is what carries it into the WebSocket — that API
cannot send an `Authorization` header, so a bearer-only scheme would leave live
reload either unauthenticated or unreachable. Scripts can use
`Authorization: Bearer <token>` instead.

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

## Build status
Under construction with Claude Code, phase by phase per `SPEC.html` §08.

## For contributors / agents
Read `SPEC.html` end to end first, then `CLAUDE.md`. `register-prototype.html` is
the visual + interaction reference. The build runs phase by phase per §08.

```
cargo run -- health                # server toolchain
cd app && pnpm install && pnpm dev # UI toolchain
```

## Contributing
See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the v1 scope fence, the
park-and-promote process, and what "green" means.

## Fonts and licensing

Three faces ship in this repository, all **SIL OFL 1.1**, each with its
`OFL.txt` beside it:

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
