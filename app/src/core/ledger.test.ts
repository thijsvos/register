import { describe, expect, it } from 'vitest'
import type { Version } from './api'
import { outsideSince, when, whoLabel } from './ledger'

function row(
  who: Version['who'],
  path = 'notes/001-a.md',
  subject = 'checkpoint: 10:00Z',
): Version {
  return {
    sha: `${'abc'.repeat(13)}a`,
    at: 1_785_921_400,
    path,
    who,
    author: 'T',
    subject,
  }
}

describe('outsideSince', () => {
  it('is nothing for a vault with no history', () => {
    expect(outsideSince([])).toEqual([])
  })

  it('counts down from the newest row and stops at your last save', () => {
    const rows = [row('outside'), row('both'), row('you'), row('outside')]
    expect(outsideSince(rows)).toEqual([rows[0], rows[1]])
  })

  it('counts everything when you never saved through the app', () => {
    const rows = [row('outside'), row(null, 'notes/002-b.md', 'note: 002 by hand')]
    expect(outsideSince(rows)).toEqual(rows)
  })

  it('counts a hand commit as outside, because it did not come through the app', () => {
    // Whoever typed `git commit`, the app did not see them do it; the server
    // reports the commit as itself, and until you save it is news.
    const rows = [row(null, 'notes/001-a.md', 'note: 001 edited in vim'), row('you')]
    expect(outsideSince(rows)).toEqual([rows[0]])
  })

  it('is empty the moment the newest row is yours', () => {
    expect(outsideSince([row('you'), row('outside')])).toEqual([])
  })
})

describe('when', () => {
  it('prints the day and the UTC stamp the checkpoint itself wrote', () => {
    expect(when(Date.UTC(2026, 7, 17, 14, 7, 9) / 1000)).toBe('17 AUG 14:07Z')
    expect(when(Date.UTC(2026, 0, 5, 0, 0, 0) / 1000)).toBe('05 JAN 00:00Z')
  })
})

describe('whoLabel', () => {
  it("says the checkpoint's word", () => {
    expect(whoLabel(row('you'))).toBe('you')
    expect(whoLabel(row('outside'))).toBe('outside')
    expect(whoLabel(row('both'))).toBe('you + outside')
  })

  it('names the hand that committed, and says so when it has no name', () => {
    expect(whoLabel(row(null))).toBe('by hand · T')
    expect(whoLabel({ ...row(null), author: '' })).toBe('by hand')
  })
})
