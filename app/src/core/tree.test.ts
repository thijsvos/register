import { describe, expect, it } from 'vitest'
import type { Entry } from './api'
import {
  ancestors,
  type Folder,
  folderTargets,
  folderTree,
  type Node,
  notesUnder,
} from './tree'

const at = (path: string, ref: string | null = null): Entry => ({
  path,
  ref,
  title: path.split('/').pop() ?? path,
  tags: [],
  mtime: 0,
  size: 0,
  etag: 'x',
})

/** The shape a reader would see: one line per row, indented by depth. */
const drawn = (nodes: Node[], depth = 0): string[] =>
  nodes.flatMap((node) =>
    node.kind === 'folder'
      ? [
          `${'  '.repeat(depth)}▾ ${node.label} [${node.count}]`,
          ...drawn(node.children, depth + 1),
        ]
      : [`${'  '.repeat(depth)}${node.entry.title}`],
  )

describe('folderTree', () => {
  it('leaves a flat vault flat', () => {
    // The property that makes this safe to ship: a vault with no folders below
    // the root renders exactly as the list did, so nothing changes for anyone
    // who never nests anything.
    const tree = folderTree([at('000-inbox.md'), at('001-a.md')])
    expect(tree.every((node) => node.kind === 'note')).toBe(true)
    expect(drawn(tree)).toEqual(['000-inbox.md', '001-a.md'])
  })

  it('draws folders before notes, each alphabetically', () => {
    // Finder, VS Code, every file tree anyone has used. The whole reason this
    // pane became a tree is that people already know how one behaves.
    const tree = folderTree([
      at('zebra.md'),
      at('notes/002-b.md'),
      at('notes/001-a.md'),
      at('areas/health/011-sleep.md'),
      at('000-inbox.md'),
    ])
    expect(drawn(tree)).toEqual([
      '▾ areas/health [1]',
      '  011-sleep.md',
      '▾ notes [2]',
      '  001-a.md',
      '  002-b.md',
      '000-inbox.md',
      'zebra.md',
    ])
  })

  it('compacts a chain of folders that holds only one folder', () => {
    // Indentation is the scarcest thing in a 250px rail. A level offering no
    // choice is a level not worth spending it on — `projects/apollo` is one row.
    const tree = folderTree([
      at('notes/projects/apollo/010-launch.md'),
      at('notes/001-a.md'),
    ])
    expect(drawn(tree)).toEqual([
      '▾ notes [2]',
      '  ▾ projects/apollo [1]',
      '    010-launch.md',
      '  001-a.md',
    ])
  })

  it('stops compacting where the tree actually branches', () => {
    // Two children is a choice, so it earns its level.
    const tree = folderTree([
      at('notes/projects/apollo/010.md'),
      at('notes/projects/gemini/011.md'),
    ])
    expect(drawn(tree)).toEqual([
      '▾ notes/projects [2]',
      '  ▾ apollo [1]',
      '    010.md',
      '  ▾ gemini [1]',
      '    011.md',
    ])
  })

  it('stops compacting where a folder holds a note of its own', () => {
    // `notes` has both a note and a subfolder, so merging them into one row
    // would hide the note behind a label naming somewhere else.
    const tree = folderTree([at('notes/001-a.md'), at('notes/archive/018-old.md')])
    expect(drawn(tree)).toEqual([
      '▾ notes [2]',
      '  ▾ archive [1]',
      '    018-old.md',
      '  001-a.md',
    ])
  })

  it('counts every note beneath a folder, not just its own', () => {
    const tree = folderTree([
      at('notes/001-a.md'),
      at('notes/archive/002-b.md'),
      at('notes/archive/deep/003-c.md'),
    ])
    const notes = tree[0] as Folder
    expect(notes.count).toBe(3)
    expect((notes.children[0] as Folder).count).toBe(2)
  })

  it('keys a folder on its full path, not its label', () => {
    // Collapse state is stored under this. Two folders called `archive` in
    // different places must not collapse together.
    const tree = folderTree([at('a/archive/1.md'), at('b/archive/2.md')])
    expect(tree.map((node) => (node as Folder).path)).toEqual(['a/archive', 'b/archive'])
    expect(tree.map((node) => (node as Folder).label)).toEqual(['a/archive', 'b/archive'])

    // A folder that is nested but NOT compacted is the case that actually
    // exercises the prefix: both folders above compact to the top level, where
    // there is no prefix to forget. Keying on the bare name survived the whole
    // suite without this — and the key is what collapse state is stored under,
    // so `notes/archive` and `logs/archive` would have folded as one.
    const nested = folderTree([at('notes/001-a.md'), at('notes/archive/018-old.md')])
    const notes = nested[0] as Folder
    expect(notes.path).toBe('notes')
    expect((notes.children[0] as Folder).path).toBe('notes/archive')
    expect((notes.children[0] as Folder).label).toBe('archive')
  })

  it('survives a vault someone else wrote', () => {
    // A vault is a folder anyone can write to. A doubled separator would key
    // the map on '' and swallow every sibling into one unnamed node.
    expect(() => folderTree([at('a//b.md'), at(''), at('trailing/')])).not.toThrow()
    const tree = folderTree([at('a//b.md')])
    expect(drawn(tree)).toEqual(['▾ a [1]', '  b.md'])
  })

  it('is empty for an empty vault', () => {
    expect(folderTree([])).toEqual([])
  })
})

describe('ancestors', () => {
  it('names every folder on the way to a note, outermost first', () => {
    expect(ancestors('notes/projects/apollo/010.md')).toEqual([
      'notes',
      'notes/projects',
      'notes/projects/apollo',
    ])
  })

  it('names nothing for a note at the root', () => {
    expect(ancestors('000-inbox.md')).toEqual([])
  })

  it('includes the intermediate folders a compacted row skips', () => {
    // `notes/projects/apollo` renders as one row, so `notes/projects` is not a
    // row at all. Revealing an open note clears all of these from the collapsed
    // set; the ones that are not rows simply match nothing, which is cheaper
    // than teaching this function about compaction.
    expect(ancestors('notes/projects/apollo/010.md')).toContain('notes/projects')
  })
})

describe('notesUnder', () => {
  const TREE = [
    at('notes/projects/010-a.md'),
    at('notes/projects/deep/011-b.md'),
    at('notes/projects-old/012-c.md'),
    at('notes/007-loose.md'),
    at('daily/2026-08-11.md'),
    at('templates/daily.md'),
  ]

  it('counts every listed note under the folder, at any depth', () => {
    expect(notesUnder(TREE, 'notes/projects')).toBe(2)
    expect(notesUnder(TREE, 'notes')).toBe(4)
  })

  it('does not count the folder whose name merely starts the same', () => {
    // Counting `notes/projects-old` here would put a number in a delete confirm
    // that the deletion never touches.
    expect(notesUnder(TREE, 'notes/projects-old')).toBe(1)
  })

  it('leaves furniture and the journal out of the number', () => {
    // `isListed`-hidden, so the reader cannot see them to agree to them. They
    // still go if the folder goes, and the server reports that afterwards.
    expect(notesUnder(TREE, 'daily')).toBe(0)
    expect(notesUnder(TREE, 'templates')).toBe(0)
  })
})

describe('folderTargets', () => {
  const AT: Entry = {
    path: 'notes/003-a.md',
    ref: '003',
    title: 'Alpha',
    tags: [],
    mtime: 0,
    size: 0,
    etag: 'v1',
  }
  const under = (path: string): Entry => ({ ...AT, path })

  it('names every real folder, uncompacted', () => {
    // `folderTree` draws `notes/projects` as one row because a chain offering no
    // choice does not earn indentation. On disk it is two folders, and a create
    // target has to name what is actually there.
    expect(folderTargets([under('notes/projects/deep/010-a.md')])).toEqual([
      'notes',
      'notes/projects',
      'notes/projects/deep',
    ])
  })

  it('offers nothing the INDEX does not draw', () => {
    // A note created in `daily/` or `templates/` is isListed-hidden: it would be
    // written, and then appear to have done nothing.
    expect(
      folderTargets([under('daily/2026-08-11.md'), under('templates/daily.md')]),
    ).toEqual([])
  })

  it('says nothing about a vault with every note at the root', () => {
    expect(folderTargets([under('000-inbox.md')])).toEqual([])
  })
})
