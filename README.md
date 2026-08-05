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
