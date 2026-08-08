import { describe, expect, it } from 'vitest'
import type { Entry } from './api'
import { conflicts, originalOf } from './conflict'
import { isConflictCopy } from './paths'

/**
 * Pairing a conflict copy back to the note it came from.
 *
 * `originalOf` is the inverse of the store's private `#park`, and the two have
 * no compile-time link — so the stamps below are the real thing, built the way
 * `#park` builds them (`toISOString().replace(/[-:.]/g, '')`, plus the `-<n>`
 * suffix it adds when two conflicts land inside one millisecond). If either side
 * changes its naming, these fail rather than the app quietly listing a conflict
 * it cannot open.
 */

/** Exactly what `#park` produces at 2026-08-08T17:28:20.123Z. */
const STAMP = '20260808T172820123Z'
const COPY = `notes/003-terminal.conflict-${STAMP}.md`
/** And the second one, from the same millisecond. */
const SECOND = `notes/003-terminal.conflict-${STAMP}-2.md`

function entry(path: string, mtime = 0): Entry {
  return { path, ref: null, title: path, tags: [], mtime, size: 0, etag: 'v1' }
}

describe('originalOf', () => {
  it('names the note a copy was parked beside', () => {
    expect(originalOf(COPY)).toBe('notes/003-terminal.md')
  })

  it('strips the collision suffix too', () => {
    expect(originalOf(SECOND)).toBe('notes/003-terminal.md')
  })

  it('agrees with the predicate the rest of the app filters on', () => {
    // `isConflictCopy` is a substring test and this is anchored, so they can
    // disagree. Where they do, `conflicts` drops the row rather than guessing —
    // but for anything `#park` actually writes, both must say yes.
    expect(isConflictCopy(COPY)).toBe(true)
    expect(originalOf(COPY)).not.toBeNull()
  })

  it('returns null for an ordinary note, so a caller cannot treat one as a copy', () => {
    expect(originalOf('notes/003-terminal.md')).toBeNull()
    expect(originalOf('daily/2026-08-08.md')).toBeNull()
    expect(originalOf('CLAUDE.md')).toBeNull()
  })

  it('does not read a folder named like a copy as one', () => {
    // The substring predicate says yes here and the anchored match says no.
    // Pairing this to `.conflict-x/003.md` minus a segment would be a guess.
    const nested = '.conflict-x/notes/003-terminal.md'
    expect(isConflictCopy(nested)).toBe(true)
    expect(originalOf(nested)).toBeNull()
  })

  it('leaves a path that only looks close alone', () => {
    expect(originalOf('notes/003-conflict-resolution.md')).toBeNull()
    expect(originalOf(`notes/003-a.conflict-${STAMP}.txt`)).toBeNull()
  })
})

describe('conflicts', () => {
  const original = entry('notes/003-terminal.md')

  it('pairs every copy to the note it came from', () => {
    const found = conflicts([original, entry(COPY, 10)])
    expect(found).toHaveLength(1)
    expect(found[0]?.copy.path).toBe(COPY)
    expect(found[0]?.from).toBe('notes/003-terminal.md')
    expect(found[0]?.original).toBe(original)
  })

  it('finds nothing in a vault with no conflicts', () => {
    // Paired with the case above, which is the positive control: without it a
    // `conflicts` that always returned [] would satisfy this forever.
    expect(conflicts([original, entry('notes/004-other.md')])).toEqual([])
  })

  it('keeps a copy whose original has been removed, with a null original', () => {
    // The copy is the only surviving revision at that point. Dropping it from
    // the list is the one outcome that could lose somebody's writing.
    const found = conflicts([entry(COPY, 10)])
    expect(found).toHaveLength(1)
    expect(found[0]?.original).toBeNull()
    expect(found[0]?.from).toBe('notes/003-terminal.md')
  })

  it('lists two copies of one note separately', () => {
    const found = conflicts([original, entry(COPY, 10), entry(SECOND, 20)])
    expect(found.map((one) => one.copy.path)).toEqual([SECOND, COPY])
  })

  it('puts the newest first, by mtime and not by tree order', () => {
    const found = conflicts([entry(SECOND, 1), original, entry(COPY, 999)])
    expect(found.map((one) => one.copy.path)).toEqual([COPY, SECOND])
  })

  it('drops a copy it cannot name rather than pairing it with a guess', () => {
    const nested = entry('.conflict-x/notes/003-terminal.md')
    expect(conflicts([original, nested])).toEqual([])
  })
})
