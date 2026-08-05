import { describe, expect, it } from 'vitest'
import type { Entry, Loaded } from './api'
import { LinkGraph, linkTargets, NoteLookup } from './links'

function entry(path: string, ref: string | null, title: string, etag = 'v1'): Entry {
  return { path, ref, title, tags: [], mtime: 0, size: 0, etag }
}

/** A vault built from `path → body`, with etags derived from the bodies. */
function vault(notes: Entry[], bodies: Record<string, string>) {
  const corpus: Record<string, Loaded> = {}
  for (const note of notes) {
    const body = bodies[note.path]
    if (body !== undefined) corpus[note.path] = { body, etag: note.etag }
  }
  return corpus
}

describe('linkTargets', () => {
  it('finds titles, refs and aliased links, in document order', () => {
    expect(
      linkTargets('see [[003]] and [[Terminal aesthetics]] and [[Perf|the rule]]'),
    ).toEqual(['003', 'Terminal aesthetics', 'Perf'])
  })

  it('counts a repeated link once, however it is cased', () => {
    expect(linkTargets('[[Perf]] again [[perf]] and [[ Perf ]]')).toEqual(['Perf'])
  })

  it('ignores an empty target and an unclosed bracket', () => {
    expect(linkTargets('[[]] [[ ]] [[unclosed and [[Real]]')).toEqual(['Real'])
  })

  it('does not run a link across a line break', () => {
    expect(linkTargets('[[open\nclosed]]')).toEqual([])
  })

  it('keeps its own lastIndex out of the next call', () => {
    // The regex is module-level and global. Two scans in a row must agree.
    const source = 'a [[One]] b [[Two]]'
    expect(linkTargets(source)).toEqual(linkTargets(source))
  })
})

describe('NoteLookup', () => {
  const notes = [
    entry('notes/003-terminal.md', '003', 'Terminal aesthetics'),
    entry('notes/004-perf.md', '004', 'Perf doctrine'),
    entry(
      'notes/003-terminal.conflict-20260805T101500000Z.md',
      '003',
      'Terminal aesthetics',
    ),
  ]
  const lookup = new NoteLookup(notes)

  it('resolves by ref and by title, case- and space-insensitively', () => {
    expect(lookup.find('003')?.path).toBe('notes/003-terminal.md')
    expect(lookup.find('  terminal AESTHETICS ')?.path).toBe('notes/003-terminal.md')
  })

  it('answers nothing for a target that does not exist', () => {
    expect(lookup.find('Nothing here')).toBeNull()
    expect(lookup.find('999')).toBeNull()
  })

  it('never resolves to a conflict copy, which carries the same ref and title', () => {
    // §04: a conflict copy is an artefact to merge, not a note to link to. If it
    // could answer, a [[003]] written before the conflict would silently start
    // pointing at a copy of the note instead of the note.
    for (const target of ['003', 'Terminal aesthetics']) {
      expect(lookup.find(target)?.path).not.toContain('.conflict-')
    }
  })

  it('prefers a ref over a title that happens to look like one', () => {
    const collide = new NoteLookup([
      entry('notes/007-seven.md', '007', 'Seven'),
      entry('notes/008-oh-seven.md', '008', '007'),
    ])
    expect(collide.find('007')?.path).toBe('notes/007-seven.md')
  })
})

describe('LinkGraph', () => {
  const notes = [
    entry('notes/003-terminal.md', '003', 'Terminal aesthetics'),
    entry('notes/004-perf.md', '004', 'Perf doctrine'),
    entry('notes/005-inbox.md', '005', 'Inbox'),
  ]
  const bodies = {
    'notes/003-terminal.md':
      'Hairlines. See [[Perf doctrine]] and [[Terminal aesthetics]].',
    'notes/004-perf.md':
      'Sixteen ms. [[003]] says the same. Again: [[Terminal aesthetics]].',
    'notes/005-inbox.md': 'Nothing links out of here.',
  }

  it('inverts links written by title and by ref alike', () => {
    const graph = new LinkGraph()
    graph.sync(notes, vault(notes, bodies))

    expect(graph.backlinks('notes/003-terminal.md').map((e) => e.path)).toEqual([
      'notes/004-perf.md',
    ])
    expect(graph.backlinks('notes/004-perf.md').map((e) => e.path)).toEqual([
      'notes/003-terminal.md',
    ])
    expect(graph.backlinks('notes/005-inbox.md')).toEqual([])
  })

  it('does not list a note as its own backlink', () => {
    // 003 links to [[Terminal aesthetics]], which is 003. A note that mentions
    // its own name is not a note that links to itself.
    const graph = new LinkGraph()
    graph.sync(notes, vault(notes, bodies))
    expect(graph.backlinks('notes/003-terminal.md').map((e) => e.path)).not.toContain(
      'notes/003-terminal.md',
    )
  })

  it('counts a source once however many times it links to the same note', () => {
    // Both dedupe layers: the same target repeated, and two different targets
    // — a ref and a title — that resolve to one note.
    const twice = {
      ...bodies,
      'notes/005-inbox.md': '[[003]] and [[003]] and [[Terminal aesthetics]]',
    }
    const graph = new LinkGraph()
    graph.sync(notes, vault(notes, twice))
    expect(graph.backlinks('notes/003-terminal.md').map((e) => e.path)).toEqual([
      'notes/004-perf.md',
      'notes/005-inbox.md',
    ])
  })

  it('ignores links written from a conflict copy', () => {
    const copy = entry(
      'notes/005-inbox.conflict-20260805T101500000Z.md',
      '005',
      'Inbox',
      'c1',
    )
    const withCopy = [...notes, copy]
    const graph = new LinkGraph()
    graph.sync(
      withCopy,
      vault(withCopy, { ...bodies, [copy.path]: 'Nothing. [[Terminal aesthetics]]' }),
    )
    expect(graph.backlinks('notes/003-terminal.md').map((e) => e.path)).toEqual([
      'notes/004-perf.md',
    ])
  })

  it('parses only what changed, and nothing at all when nothing did', () => {
    const graph = new LinkGraph()
    const corpus = vault(notes, bodies)

    expect(graph.sync(notes, corpus)).toBe(3)
    expect(graph.sync(notes, corpus)).toBe(0)

    corpus['notes/005-inbox.md'] = { body: 'Now it links: [[003]]', etag: 'v2' }
    expect(graph.sync(notes, corpus)).toBe(1)
    expect(graph.backlinks('notes/003-terminal.md').map((e) => e.path)).toEqual([
      'notes/004-perf.md',
      'notes/005-inbox.md',
    ])
  })

  it('re-points every link when a title changes without a body changing', () => {
    // The tree carries titles; the corpus carries bodies. Renaming 004 makes
    // [[Perf doctrine]] dangle even though no body this graph holds moved.
    const graph = new LinkGraph()
    const corpus = vault(notes, bodies)
    graph.sync(notes, corpus)

    const renamed = notes.map((note) =>
      note.ref === '004' ? { ...note, title: 'Latency doctrine' } : note,
    )
    expect(graph.sync(renamed, corpus)).toBe(0)
    expect(graph.backlinks('notes/004-perf.md')).toEqual([])
  })

  it('forgets a note that left the vault', () => {
    const graph = new LinkGraph()
    graph.sync(notes, vault(notes, bodies))

    const left = notes.filter((note) => note.ref !== '004')
    graph.sync(left, vault(left, bodies))
    expect(graph.backlinks('notes/003-terminal.md')).toEqual([])
  })

  it('holds a note out of the graph until its body arrives', () => {
    const graph = new LinkGraph()
    // The tree paints before the corpus fills, so a body-less note is unknown,
    // not link-less — otherwise every boot would flash "no backlinks".
    expect(graph.sync(notes, {})).toBe(0)
    expect(graph.backlinks('notes/003-terminal.md')).toEqual([])

    expect(graph.sync(notes, vault(notes, bodies))).toBe(3)
    expect(graph.backlinks('notes/003-terminal.md')).toHaveLength(1)
  })
})
