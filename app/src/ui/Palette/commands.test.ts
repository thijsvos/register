import { beforeEach, describe, expect, it } from 'vitest'
import type { Entry } from '../../core/api'
import { vault } from '../../core/store.svelte'
import { fuzzyScore, templateChoices, UNTITLED } from './commands'

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
