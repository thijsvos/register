# Using REGISTER with Claude Code

REGISTER is a folder of markdown that an app renders live. There is no database
and no API you have to learn: an agent edits the files with the tools it already
has, and the UI repaints within 100 ms.

## Three commands

```sh
register init ~/vault        # scaffold a vault
register serve ~/vault       # open it at http://127.0.0.1:7777
cd ~/vault && claude         # point the agent at the same folder
```

That is the whole setup. Leave `serve` running in one terminal and work in the
vault from another — the two never talk to each other, they just share a folder.

`register init` creates §04's layout and writes `CLAUDE.md` into the vault. That
file is the agent's entire brief: layout, frontmatter, the two pieces of syntax
the app understands, and how to allocate a ref. Claude Code reads it
automatically, so an agent started in the vault knows how to write a conforming
note without being told anything.

It never overwrites. Run it on a folder you already have and it fills in what is
missing, saying which files it kept.

## Watching an agent work

This is the demo worth staging, and it is the product's whole argument:

1. `register serve ~/vault`, open the browser.
2. In another terminal, `cd ~/vault && claude`.
3. Ask for something that writes a note — *"read the Kleppmann CRDT paper and
   put your notes in this vault, linked from the inbox"*.
4. Watch the sidebar. The note appears as the agent writes it, the status LED
   reports the watcher, and the row paints in place.

Nothing is syncing. The agent wrote a file; the app noticed.

## Creating notes

An agent has two routes, and both are fine:

**Write the file.** This is the normal one. `CLAUDE.md` gives the format. The
only rule with teeth is the ref: **one above the highest ever used, counting
`.register/trash/`** — never reuse a deleted one, or a `[[NNN]]` link written
last month silently starts pointing at different prose.

**Or ask the binary.** `register new "CRDT reading"` allocates the ref, mints a
ULID, writes a conforming note and prints its path. Run it inside the vault, or
name one with `--vault ~/vault` from anywhere. Either way it checks the directory
is a vault first and refuses if it is not, rather than scattering notes into
whatever folder was current.

```sh
$ cd ~/vault && register new "CRDT reading"
notes/003-crdt-reading.md
```

Use it when the agent is working the files directly and cannot see the server;
use the file-writing route when it wants to write the body in the same breath.

## What the app understands

Two things beyond ordinary markdown, both plain text:

| | |
|---|---|
| `[[Title]]` or `[[003]]` | a wikilink — resolves by title or ref, opens instantly, offers to create when the target is missing |
| `- [ ]` / `- [x]` | a task — appears in TODAY across the whole vault, and ticking it there writes back to this file |

Everything else — backlinks, tags, the outline, search — is derived from the text
on read. Nothing is stored, so nothing can be stale and nothing needs migrating.

## Rules an agent should keep

- **Never touch `.register/`.** It is the app's, and it holds the trash that
  makes refs unrepeatable.
- **`000-inbox.md` is append-only.** It is a capture queue; reorganising it
  destroys the order things arrived in.
- **`*.conflict-*.md` are unresolved edits**, written when the app and something
  else changed a note at once. Merge into the original, then delete the copy.
  Nothing is ever thrown away, so these are safe to leave until you get to them.
- **Frontmatter round-trips byte for byte** apart from `modified`. Formatting,
  key order and comments survive whatever the UI does, so an agent and a human
  can edit the same file without churning each other's work.

## If the vault is a git repo

`register init --git` initialises one and ignores the two directories that must
never be committed: `.register/fonts/` (licensed font bytes, §03) and
`.register/trash/`.

Commit in small units, with the ref in the message:

```
note: 014 add crdt reading notes
```
