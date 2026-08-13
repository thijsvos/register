import { beforeEach, describe, expect, it } from 'vitest'
import type { Entry } from '../../core/api'
import { vault } from '../../core/store.svelte'
import {
  allCommands,
  folderChoices,
  fuzzyScore,
  openFolder,
  templateChoices,
  UNTITLED,
} from './commands'

describe('allCommands', () => {
  it('names a key for every binding it has, and shows none where there is none', () => {
    // §01: "every control shows its key". The palette is where this product
    // says them, so a command with a global binding and a blank `keys` is a
    // binding only its author knows about.
    const named = new Map(allCommands().map((command) => [command.id, command.keys]))

    expect(named.get('new')).toBe('N')
    expect(named.get('focus-index')).toBe('J')
    // The one added with the keyboard route to a link: §02b draws no keyboard
    // follow, so without this row `Mod-Enter` appears nowhere on screen.
    expect(named.get('follow')).toBe('⌘↵')
    expect(named.get('settings')).toBe('')
  })

  it('gives every command a distinct id', () => {
    const ids = allCommands().map((command) => command.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('fuzzyScore', () => {
  it('matches an empty query against anything', () => {
    expect(fuzzyScore('TOGGLE INSPECTOR', '')).toBe(0)
  })

  it('matches a subsequence, which is what a palette is for', () => {
    // The whole point: `tgi` should find TOGGLE INSPECTOR without typing it out.
    expect(fuzzyScore('TOGGLE INSPECTOR', 'tgi')).not.toBeNull()
    expect(fuzzyScore('TOGGLE INSPECTOR', 'insp')).not.toBeNull()
  })

  it('rejects a query whose characters are not all present, in order', () => {
    expect(fuzzyScore('TOGGLE INSPECTOR', 'xyz')).toBeNull()
    expect(fuzzyScore('TOGGLE INSPECTOR', 'rotcepsni')).toBeNull()
  })

  it('is case-insensitive both ways', () => {
    expect(fuzzyScore('Terminal aesthetics', 'TERM')).not.toBeNull()
    expect(fuzzyScore('TERMINAL AESTHETICS', 'term')).not.toBeNull()
  })

  it('scores a contiguous prefix better than a scattered match', () => {
    const prefix = fuzzyScore('Terminal aesthetics', 'term')
    const scattered = fuzzyScore('Terminal aesthetics', 'tles')
    expect(prefix).not.toBeNull()
    expect(scattered).not.toBeNull()
    expect(prefix ?? 0).toBeLessThan(scattered ?? 0)
  })

  it('scores an early match better than a late one', () => {
    const early = fuzzyScore('alpha bravo', 'a')
    const late = fuzzyScore('bravo alpha', 'a')
    expect(early ?? 0).toBeLessThan(late ?? 0)
  })

  it('ranks the intended note first for a realistic query', () => {
    const titles = ['Perf doctrine', 'Terminal aesthetics', 'Reading list']
    const ranked = titles
      .map((title) => ({ title, score: fuzzyScore(title, 'termi') }))
      .filter((row): row is { title: string; score: number } => row.score !== null)
      .sort((a, b) => a.score - b.score)

    expect(ranked[0]?.title).toBe('Terminal aesthetics')
  })
})

describe('templateChoices', () => {
  /** A stencil as `register init` actually writes it: every field a placeholder. */
  const DAILY: Entry = {
    path: 'templates/daily.md',
    ref: null,
    title: 'TEMPLATE',
    tags: ['daily'],
    mtime: 0,
    size: 0,
    etag: 'v1',
  }
  const NOTE: Entry = { ...DAILY, path: 'notes/003-a.md', ref: '003', title: 'Alpha' }

  beforeEach(() => {
    vault.tree = [NOTE, DAILY]
  })

  it('never gives a new note the stencil’s own title', () => {
    // The bug this exists for. `templates/daily.md` is titled TEMPLATE, so an
    // empty box used to create a note called TEMPLATE — which then sat in the
    // index next to real notes and was indistinguishable from one. Two of those
    // turned up in a real vault before anyone noticed.
    expect(templateChoices('')[0]?.title).not.toBe('TEMPLATE')
    expect(templateChoices('')[0]?.title).toBe(UNTITLED)
  })

  it('uses the same name for an unnamed note as the N key does', () => {
    // Two ways to make a note nobody has named; one word for it.
    expect(templateChoices('  ')[0]?.title).toBe(UNTITLED)
  })

  it('takes whatever you typed as the title, trimmed', () => {
    // The positive control: without this, a `templateChoices` that always
    // returned UNTITLED would satisfy both assertions above forever.
    expect(templateChoices('  Reading list  ')[0]?.title).toBe('Reading list')
  })

  it('still labels the row by the stencil, so you can tell which one it is', () => {
    // The stencil's title names the stencil. It is fine as a label and wrong as
    // the new note's title, and that distinction is the whole fix.
    expect(templateChoices('')[0]?.name).toBe('TEMPLATE')
    expect(templateChoices('')[0]?.path).toBe('templates/daily.md')
  })

  it('falls back to the filename when a stencil has no title at all', () => {
    vault.tree = [{ ...DAILY, title: null }]
    expect(templateChoices('')[0]?.name).toBe('daily')
  })

  it('offers stencils only, never ordinary notes', () => {
    expect(templateChoices('x').map((one) => one.path)).toEqual(['templates/daily.md'])
  })
})

describe('the folder a delete command can name', () => {
  const AT: Entry = {
    path: 'notes/003-a.md',
    ref: '003',
    title: 'Alpha',
    tags: [],
    mtime: 0,
    size: 0,
    etag: 'v1',
  }

  beforeEach(() => {
    vault.tree = [AT]
  })

  it('offers the folder the open note is in, deepest first', () => {
    vault.openPath = 'notes/projects/deep/011-b.md'
    expect(openFolder()).toBe('notes/projects/deep')
  })

  it('offers nothing for a note at the vault root, or none open', () => {
    vault.openPath = '000-inbox.md'
    expect(openFolder()).toBeNull()
    vault.openPath = null
    expect(openFolder()).toBeNull()
  })
})

describe('folderChoices', () => {
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

  beforeEach(() => {
    vault.tree = [
      under('notes/projects/010-a.md'),
      under('notes/projects/deep/011-b.md'),
      under('notes/personal/012-c.md'),
      under('notes/007-loose.md'),
      under('daily/2026-08-11.md'),
    ]
  })

  const paths = (query: string) => folderChoices(query).map((row) => row.path)

  it('finds a folder from a prefix of its name', () => {
    expect(paths('proj')).toContain('notes/projects')
  })

  it('finds one from a subsequence, the way the commands match', () => {
    // The rule ⌘K already uses — `tgi` finds TOGGLE INSPECTOR — applied to a
    // path. Two letters is what the request was: `pr`.
    expect(paths('pr')).toContain('notes/projects')
  })

  it('says nothing to one character', () => {
    // A single letter matches nearly every folder a vault has, on a surface
    // whose other rows are what the reader is usually after.
    expect(paths('p')).toEqual([])
    expect(paths('')).toEqual([])
  })

  it('narrows to what is inside a folder once one is settled', () => {
    // Choosing a row types `notes/projects/`. What still matches from there is
    // only what is *inside* it, which is the next completion rather than noise —
    // the folder itself no longer does, because the trailing separator is not
    // part of its path.
    expect(paths('notes/projects')).toContain('notes/projects')
    expect(paths('notes/projects/')).toEqual(['notes/projects/deep'])
  })

  it('clears itself the moment a title follows the separator', () => {
    // The property that makes this need no mode: nothing has to notice that you
    // stopped naming a place and started naming a note.
    expect(paths('notes/projects/Launch plan')).toEqual([])
    expect(paths('notes/Terminal aesthetics')).toEqual([])
  })

  it('never offers a folder the INDEX does not draw', () => {
    expect(paths('dai')).toEqual([])
  })

  it('ranks the closer match first', () => {
    const ranked = paths('pe')
    expect(ranked[0]).toBe('notes/personal')
  })

  it('reports how many notes are already there', () => {
    const found = folderChoices('proj').find((row) => row.path === 'notes/projects')
    expect(found?.notes).toBe(2)
  })
})

describe('templateChoices with a folder', () => {
  const DAILY: Entry = {
    path: 'templates/daily.md',
    ref: null,
    title: 'TEMPLATE',
    tags: [],
    mtime: 0,
    size: 0,
    etag: 'v1',
  }

  beforeEach(() => {
    vault.tree = [DAILY]
  })

  it('splits a typed path into a destination and a title', () => {
    const [choice] = templateChoices('notes/projects/Launch plan')
    expect(choice?.folder).toBe('notes/projects')
    expect(choice?.title).toBe('Launch plan')
  })

  it('keeps the untitled fallback when only a folder was typed', () => {
    const [choice] = templateChoices('notes/projects/')
    expect(choice?.folder).toBe('notes/projects')
    expect(choice?.title).toBe(UNTITLED)
  })

  it('means §04s default when no folder was typed', () => {
    const [choice] = templateChoices('Launch plan')
    expect(choice?.folder).toBeNull()
    expect(choice?.title).toBe('Launch plan')
  })
})
