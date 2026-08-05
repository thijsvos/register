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

From v1.0 onward: prebuilt binaries on the GitHub release page for macOS
(arm64/x64), Linux (x64/arm64, musl) and Windows x64, or `cargo install
register-notes`.

### Container

```sh
VAULT_PATH=~/vault docker compose -f deploy/docker-compose.yml up -d
```

Serves on `http://localhost:7777` against the folder you mounted. The image is
three stages down to `scratch`, so it is the binary and nothing else — no shell,
no package manager, a few megabytes.

Two things worth knowing before you publish that port:

- The container binds `0.0.0.0` because a published port needs it, not because
  the server is meant to be reachable from a network. The Origin and Host guards
  still hold, and `/api/reveal` refuses outright on a non-loopback bind — but
  putting this on a network is a decision. Behind Tailscale is the intended
  shape.
- Agents still run on the **host**, against the same mounted folder. The
  container only serves the UI.

Images are published to `ghcr.io/OWNER/register` on tags, addressable by version
only — there is no `latest`, deliberately, because nothing should depend on a
tag that moves under it.

## Build status
Under construction with Claude Code, phase by phase per `SPEC.html` §08.

## For contributors / agents
Read `SPEC.html` end to end first, then `CLAUDE.md`. `register-prototype.html` is
the visual + interaction reference. The build runs phase by phase per §08.

```
cargo run -- health                # server toolchain
cd app && pnpm install && pnpm dev # UI toolchain
```

## License
MIT (code) · SIL OFL 1.1 (bundled fonts). Berkeley Mono / TX-02 is commercial and
is never bundled — load your own via Settings → BYOF.
