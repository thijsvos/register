# Fixtures

## `vault-v1/` — frozen, and that is the whole point

A vault as v1 leaves it on disk. §09 asks for exactly this: *"a vault written by
v1 opens unchanged in every later minor — §04 is the contract."*

**Do not regenerate it. Do not tidy it. Do not run the formatter over it.**

Every other test input in this repository is a string literal declared in the
same commit — usually the same file, in the same language — as the code that
reads it. That is fine for behaviour and useless for compatibility: a change that
moves the reader and the writer together stays green. This directory is the one
input that does not move when the code does.

It is read by both suites, so the two parsers of §04 are pinned to the same
bytes:

- `tests/compat.rs` — Rust, reader-only
- `app/src/core/compat.test.ts` — the client's `frontmatter.ts` over the same files

### What is deliberately odd in here

Half of these files are things this app would never write. That is the point —
a vault is edited by agents, by `vim`, by whatever the user has to hand, and §04
is a promise about what can be *read*, not only about what gets written.

| File | Why it exists |
|---|---|
| `notes/003-terminal-aesthetics.md` | The control: an ordinary note, exactly as v1 writes one. If this one ever fails, nothing else here is worth reading. |
| `notes/004-loose-fence.md` | Opening fence is `--- ` — three dashes and one trailing space. |
| `notes/005-crlf.md` | CRLF throughout, fences included. |
| `notes/006-bom.md` | A UTF-8 BOM before the opening fence. |
| `notes/007-unknown-keys.md` | Frontmatter keys this app has never heard of, plus a YAML comment. Both must survive a save. |
| `notes/008-duplicate-key.md` | Two `title:` keys. ADR-001 has an opinion about this. |
| `notes/0009-wide-ref.md` | A four-digit ref, where §04's examples are three. |
| `notes/010-no-newline.md` | The last byte is not a newline. |
| `notes/011-loose-close.md` | The *closing* fence carries trailing spaces while the opening one does not. Added because a mutation proved the closing half of the rule was unguarded without it. |
| `notes/003-….conflict-20260805T101500000Z.md` | A conflict copy carrying 003's ref and title verbatim. |
| `.register/trash/1754386500000/notes/002-retired.md` | A trashed note, so `nextRef` has something to refuse to reissue. |

### Two things it deliberately does not have

**No `.gitignore`.** `register init --git` writes one listing `.register/trash/`,
and carrying it here would mean git never stored the trash bucket — so the one
file that proves a ref is never reissued would not be in the repository.

**No `README.md` inside the vault.** A markdown file at the vault root is a note
to `/api/tree`, and a fixture that documents itself from the inside would have to
appear in its own expected tree. This file sits one level up for that reason.

### The `.gitattributes` at the repo root is load-bearing

`tests/fixtures/vault-v1/** -text` keeps git from normalising line endings on the
way in. Without it, `core.autocrlf=input` rewrites `005-crlf.md` to LF and the
CRLF test silently starts testing LF.
