import { describe, expect, it } from 'vitest'
import { apply, moved, rewrites } from './move'

/**
 * §04 Rev Y — what a move has to rewrite.
 *
 * The ruling this implements was argued from "does the app rewrite your prose",
 * and the answer turned out to be *hardly ever*: `[[wikilinks]]` resolve by ref
 * or title and survive a move untouched, so only relative `![](src)` references
 * are in scope — and a folder carries its images with it. These pin how narrow
 * that is, because the narrowness is the design.
 */

const corpus = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([path, body]) => [path, { body }]))

describe('moved', () => {
  it('follows a note', () => {
    expect(moved('notes/003-a.md', 'notes/003-a.md', 'archive/003-a.md')).toBe(
      'archive/003-a.md',
    )
  })

  it('follows everything under a folder', () => {
    expect(moved('notes/apollo/010.md', 'notes/apollo', 'archive/apollo')).toBe(
      'archive/apollo/010.md',
    )
  })

  it('leaves a path the move does not touch', () => {
    expect(moved('notes/004-b.md', 'notes/apollo', 'archive/apollo')).toBeNull()
    // A prefix that is not a folder boundary is not a match.
    expect(moved('notes/apollo-2/010.md', 'notes/apollo', 'archive/apollo')).toBeNull()
  })
})

describe('rewrites', () => {
  it('moving a folder whole rewrites nothing', () => {
    // The case that matters most, and the one the old framing missed: the images
    // travel with the notes, so every relative reference still means what it
    // said.
    const held = corpus({
      'notes/apollo/010-launch.md': 'A plan.\n\n![The frame](diagram.png)\n',
      'notes/apollo/011-next.md': 'See [[Launch plan]] and ![it](diagram.png)\n',
    })
    expect(rewrites(held, 'notes/apollo', 'archive/apollo')).toEqual([])
  })

  it('re-points a note moved away from its image', () => {
    const held = corpus({
      'notes/010-launch.md': 'A plan.\n\n![The frame](diagram.png)\n',
    })
    const changes = rewrites(held, 'notes/010-launch.md', 'archive/010-launch.md')
    expect(changes).toEqual([
      { note: 'archive/010-launch.md', was: 'diagram.png', now: '../notes/diagram.png' },
    ])
  })

  it('re-points a note left behind when its image moves', () => {
    const held = corpus({
      'notes/010-launch.md': '![The frame](assets/diagram.png)\n',
    })
    const changes = rewrites(held, 'notes/assets', 'archive/assets')
    expect(changes).toEqual([
      {
        note: 'notes/010-launch.md',
        was: 'assets/diagram.png',
        now: '../archive/assets/diagram.png',
      },
    ])
  })

  it('leaves wikilinks alone, because they never resolved by path', () => {
    const held = corpus({
      'notes/010-launch.md': 'See [[Design doctrine]] and [[003]].\n',
    })
    expect(rewrites(held, 'notes/010-launch.md', 'archive/010-launch.md')).toEqual([])
  })

  it('leaves anything that was never a vault path', () => {
    const held = corpus({
      'notes/010-launch.md':
        '[out](https://example.com) [mail](mailto:a@b.c) [proto](//cdn/x.png)\n',
    })
    expect(rewrites(held, 'notes/010-launch.md', 'archive/010-launch.md')).toEqual([])
  })

  it('keeps the reference relative rather than rewriting it absolute', () => {
    // §12: markdown stays the literal source. Turning every moved reference into
    // a form the writer did not use is the app editing prose in a way they would
    // notice — `../` is what a person would have typed.
    const held = corpus({ 'a/b/note.md': '![x](img.png)\n' })
    const changes = rewrites(held, 'a/b/note.md', 'a/note.md')
    expect(changes[0]?.now).toBe('b/img.png')
    expect(changes[0]?.now.startsWith('/')).toBe(false)
  })
})

describe('apply', () => {
  it('rewrites only the reference it was told about', () => {
    const body = '![one](a.png) and ![two](b.png)\n'
    const out = apply(body, [{ note: 'x.md', was: 'a.png', now: '../a.png' }])
    expect(out).toBe('![one](../a.png) and ![two](b.png)\n')
  })

  it('leaves a body with nothing to change byte for byte', () => {
    const body = 'Prose, [[a wikilink]], and ![an image](x.png).\n'
    expect(apply(body, [])).toBe(body)
  })

  it('does not touch the alt text, only the target', () => {
    const body = '![a.png is the old name](a.png)\n'
    const out = apply(body, [{ note: 'x.md', was: 'a.png', now: 'sub/a.png' }])
    expect(out).toBe('![a.png is the old name](sub/a.png)\n')
  })
})
