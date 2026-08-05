import { describe, expect, it } from 'vitest'
import type { Entry } from './api'
import { countsFor, tagCounts } from './tags'

function entry(path: string, tags: string[]): Entry {
  return { path, ref: null, title: path, tags, mtime: 0, size: 0, etag: 'v1' }
}

const NOTES = [
  entry('notes/003-a.md', ['design', 'research']),
  entry('notes/004-b.md', ['design']),
  entry('notes/005-c.md', ['design', 'perf']),
  entry('notes/006-d.md', []),
]

describe('tagCounts', () => {
  it('counts notes per tag, commonest first', () => {
    expect(tagCounts(NOTES)).toEqual([
      { name: 'design', count: 3 },
      { name: 'perf', count: 1 },
      { name: 'research', count: 1 },
    ])
  })

  it('breaks ties alphabetically, so a refresh cannot reorder the meters', () => {
    const [, second, third] = tagCounts(NOTES)
    expect([second?.name, third?.name]).toEqual(['perf', 'research'])
  })

  it('counts a note once for a tag it lists twice', () => {
    expect(tagCounts([entry('notes/007-e.md', ['design', 'design'])])).toEqual([
      { name: 'design', count: 1 },
    ])
  })

  it('ignores an empty tag', () => {
    expect(tagCounts([entry('notes/008-f.md', ['', '   ', 'real'])])).toEqual([
      { name: 'real', count: 1 },
    ])
  })

  it('does not count a conflict copy, which carries the original tags', () => {
    // Otherwise one unresolved conflict silently doubles a tag's meter.
    const copy = entry('notes/003-a.conflict-20260805T101500000Z.md', [
      'design',
      'research',
    ])
    expect(tagCounts([...NOTES, copy])).toEqual(tagCounts(NOTES))
  })

  it('does not count a stencil’s tags or the agent contract as yours', () => {
    // The vault Claude Code wrote showed #daily = 1 with no daily note in it:
    // templates/daily.md carries `tags: [daily]`, and a meter for a tag no note
    // of yours has is a gauge reporting something that is not there.
    const furniture = [
      entry('templates/daily.md', ['daily']),
      entry('CLAUDE.md', ['design']),
    ]
    expect(tagCounts([...NOTES, ...furniture])).toEqual(tagCounts(NOTES))
  })

  it('reads an untagged vault as no tags at all', () => {
    expect(tagCounts([entry('notes/009-g.md', [])])).toEqual([])
    expect(tagCounts([])).toEqual([])
  })
})

describe('countsFor', () => {
  it('keeps the note’s own order and attaches the vault-wide count', () => {
    expect(countsFor(NOTES, ['research', 'design'])).toEqual([
      { name: 'research', count: 1 },
      { name: 'design', count: 3 },
    ])
  })

  it('reports zero for a tag the tree has not caught up with', () => {
    // The buffer is ahead of the tree between a keystroke and a save, so a tag
    // just typed is real but not yet counted anywhere.
    expect(countsFor(NOTES, ['brand-new'])).toEqual([{ name: 'brand-new', count: 0 }])
  })
})
