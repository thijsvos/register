import { describe, expect, it } from 'vitest'
import type { Entry, Loaded } from './api'
import { count, taskGroups, tasksIn, toggle } from './tasks'

const FRONT = ['---', 'id: 01J2ZK7Q8W3E5R9T', 'ref: 003', '---'].join('\n')

function entry(path: string, ref: string | null = null): Entry {
  return { path, ref, title: path, tags: [], mtime: 0, size: 0, etag: 'v1' }
}

function vault(rows: [Entry, string][]) {
  const corpus: Record<string, Loaded> = {}
  for (const [note, body] of rows) corpus[note.path] = { body, etag: note.etag }
  return { notes: rows.map(([note]) => note), corpus }
}

describe('tasksIn', () => {
  it('reads open and done boxes with their text', () => {
    const source = `${FRONT}\n- [ ] first\n- [x] second\n- [X] third\n`
    expect(tasksIn('a.md', source).map(({ done, text }) => ({ done, text }))).toEqual([
      { done: false, text: 'first' },
      { done: true, text: 'second' },
      { done: true, text: 'third' },
    ])
  })

  it('points at the opening bracket, whatever the indent or marker', () => {
    const source = `${FRONT}\n  * [ ] starred\n1. [ ] numbered\n+ [ ] plussed\n`
    for (const task of tasksIn('a.md', source)) {
      expect(source.slice(task.at, task.at + 3)).toBe('[ ]')
    }
    expect(tasksIn('a.md', source)).toHaveLength(3)
  })

  it('ignores a box that is not a list item', () => {
    // Prose that happens to contain brackets is prose.
    expect(tasksIn('a.md', `${FRONT}\n[ ] not a list\nsee [x] there\n`)).toEqual([])
  })

  it('ignores a box inside a fenced code block', () => {
    const source = [
      FRONT,
      '- [ ] real',
      '```md',
      '- [ ] sample',
      '```',
      '- [x] also real',
    ].join('\n')
    expect(tasksIn('a.md', source).map((t) => t.text)).toEqual(['real', 'also real'])
  })

  it('never reads frontmatter as a task', () => {
    const source = '---\ntags: [a]\n- [ ] not real\n---\n- [ ] real\n'
    expect(tasksIn('a.md', source).map((t) => t.text)).toEqual(['real'])
  })

  it('reads an empty task as an empty line, not as no task', () => {
    expect(tasksIn('a.md', `${FRONT}\n- [ ]\n- [ ] \n`)).toHaveLength(2)
  })

  it('keeps offsets exact across CRLF', () => {
    const source = `${FRONT}\r\n- [ ] one\r\n- [x] two\r\n`
    for (const task of tasksIn('a.md', source)) {
      expect(source.slice(task.at, task.at + 3)).toMatch(/^\[[ x]\]$/)
    }
  })
})

describe('toggle', () => {
  const source = '- [ ] one\n- [x] two\n'

  it('ticks and unticks one character, leaving every other byte', () => {
    const ticked = toggle(source, 2)
    expect(ticked).toBe('- [x] one\n- [x] two\n')
    expect(toggle(ticked ?? '', 2)).toBe(source)
  })

  it('unticks a done task', () => {
    expect(toggle(source, 12)).toBe('- [ ] one\n- [ ] two\n')
  })

  it('refuses an offset that is no longer a box', () => {
    // The offset came from a snapshot; an agent inserting a paragraph above
    // shifts every task below it, and splicing blind would rewrite prose.
    expect(toggle(source, 3)).toBeNull()
    expect(toggle(source, 0)).toBeNull()
    expect(toggle(source, 999)).toBeNull()
    expect(toggle('- [~] odd\n', 2)).toBeNull()
  })
})

describe('taskGroups', () => {
  const notes: [Entry, string][] = [
    [entry('notes/001-a.md', '001'), `${FRONT}\n- [ ] alpha\n- [x] beta\n`],
    [entry('notes/002-b.md', '002'), `${FRONT}\nNo tasks here.\n`],
    [entry('notes/003-c.md', '003'), `${FRONT}\n- [ ] gamma\n`],
  ]

  it('groups by note and skips notes with none', () => {
    const { notes: tree, corpus } = vault(notes)
    const groups = taskGroups(tree, corpus)
    expect(groups.map((g) => g.entry.ref)).toEqual(['001', '003'])
    expect(groups[0]?.tasks.map((t) => t.text)).toEqual(['alpha', 'beta'])
  })

  it('counts open and total across the whole vault', () => {
    const { notes: tree, corpus } = vault(notes)
    expect(count(taskGroups(tree, corpus))).toEqual({ open: 2, total: 3 })
  })

  it('leaves templates out', () => {
    // A stencil's `- [ ]` is a placeholder for a task, not a task. Counting it
    // would put the same unfinished line on your plate every day forever.
    const withTemplate: [Entry, string][] = [
      ...notes,
      [entry('templates/daily.md'), `${FRONT}\n- [ ] placeholder\n`],
    ]
    const { notes: tree, corpus } = vault(withTemplate)
    expect(taskGroups(tree, corpus).map((g) => g.entry.path)).toEqual([
      'notes/001-a.md',
      'notes/003-c.md',
    ])
  })

  it('keeps daily logs in, which is the whole reason TODAY exists', () => {
    // A daily log is hidden from the INDEX — one per day forever would bury the
    // notes — but it is where people actually write `- [ ]`, so it has to stay
    // counted. Nothing pinned this until `isListed` and `isDerived` were
    // untangled, and defining derived in terms of listed empties TODAY silently.
    const withDaily: [Entry, string][] = [
      ...notes,
      [entry('daily/2026-08-05.md'), `${FRONT}\n- [ ] from the daily log\n`],
    ]
    const { notes: tree, corpus } = vault(withDaily)
    expect(taskGroups(tree, corpus).map((g) => g.entry.path)).toContain(
      'daily/2026-08-05.md',
    )
    expect(count(taskGroups(tree, corpus))).toEqual({ open: 3, total: 4 })
  })

  it('leaves conflict copies out', () => {
    const withCopy: [Entry, string][] = [
      ...notes,
      [entry('notes/001-a.conflict-20260805T101500000Z.md'), `${FRONT}\n- [ ] alpha\n`],
    ]
    const { notes: tree, corpus } = vault(withCopy)
    expect(count(taskGroups(tree, corpus))).toEqual({ open: 2, total: 3 })
  })

  it('holds a note out until its body arrives', () => {
    const { notes: tree } = vault(notes)
    expect(taskGroups(tree, {})).toEqual([])
  })
})
