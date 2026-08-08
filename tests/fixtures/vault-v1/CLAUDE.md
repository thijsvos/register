# This folder is a REGISTER vault — agent contract

Plain markdown, rendered live by the REGISTER app. There is no
database; these files are the entire state. Edit them freely with
normal file tools — the UI hot-reloads within 100 ms.

## Layout
notes/NNN-slug.md     # NNN = zero-padded ref, immutable
daily/YYYY-MM-DD.md   # daily logs
000-inbox.md          # capture queue — append, don't reorganize
templates/            # note templates
.register/            # app config — do not read or write

## Note format (required frontmatter)
---
id: ULID              # never change an existing id
ref: NNN              # never change an existing ref
title: Plain title
created: YYYY-MM-DD
modified: ISO-8601    # update when you edit
tags: [lowercase, words]
---

## Syntax that the app understands
[[Title]] or [[NNN]]  wikilink        - [ ] / - [x]  task
Everything else is ordinary markdown.

## Creating a note
1. ref  = the `nextRef` from GET /api/tree, or if you are working
   the files directly: one above the highest NNN ever used, counting
   .register/trash/ — never reuse a deleted ref
2. id   = fresh ULID
3. file = notes/NNN-kebab-slug.md with full frontmatter

## Rules
- Never touch .register/ .
- *.conflict-*.md are unresolved conflicts: merge into the
  original, then delete the conflict file.
- If this vault is a git repo, commit in small units with
  messages like "note: 014 add crdt reading notes".
