import { describe, expect, it } from 'vitest'
import { fuzzyScore } from './commands'

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
