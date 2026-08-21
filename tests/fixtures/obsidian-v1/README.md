# obsidian-v1 — a frozen source vault

What `register import` is tested against. Every file here exists to make one
conversion rule fail if it stops holding, in the same spirit as `vault-v1/`
next door: this is an **adversarial** corpus, not a plausible one.

| File | What it pins |
|---|---|
| `Terminal Aesthetics.md` | frontmatter title; a tag list; a nested tag; an anchored link; an aliased link |
| `Reading List.md` | `tags:` as one comma scalar; an H1 title; an inline `#tag`; a markdown link to a note |
| `folder/Nested Note.md` | a note reached by folder path, and a heading to anchor onto |
| `2026-08-21.md` | a dated name, which §04 puts in `daily/` with no ref |
| `No Frontmatter.md` | a note that is all body |
| `Embeds.md` | an image embed, a note embed, and an embed of a file that is not here |
| `Code Sample.md` | links inside a fence and inside an inline span, which must not be rewritten |
| `Untitled.md` | no title anywhere, so the filename is the only evidence |
| `attachments/diagram.png` | a real PNG container, copied and referenced |
| `.obsidian/app.json` | a dotted directory, which the walk must skip entirely |

`README.md` itself is a note as far as the importer is concerned, and that is
deliberate — an Obsidian vault usually has one, and it must convert like any
other file rather than being special-cased.
