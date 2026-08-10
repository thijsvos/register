import { describe, expect, it } from 'vitest'
import type { GitStatus } from './api'
import { DETACHED, gitLabel } from './git'

/** A clean repository on `main`, which every case below varies from. */
const on = (over: Partial<GitStatus> = {}): GitStatus => ({
  branch: 'main',
  clean: true,
  staged: 0,
  modified: 0,
  untracked: 0,
  ahead: null,
  ...over,
})

describe('gitLabel', () => {
  it('says nothing when there is nothing true to say', () => {
    // Not "clean", not "no repo" — the em dash the status bar draws for null.
    // A vault that is not a repository and a server that cannot answer are both
    // absences, and inventing a state for either would be a gauge showing a
    // number the system cannot measure.
    expect(gitLabel(null)).toBeNull()
  })

  it('is just the branch when the tree matches it', () => {
    // §02's "every pixel accounted for": no marks means no marks, not `+0 ~0 ?0`
    // in 30px of rail shared with five other fields.
    expect(gitLabel(on())).toBe('main')
  })

  it.each([
    ['staged', { staged: 2, clean: false }, 'main +2'],
    ['modified', { modified: 3, clean: false }, 'main ~3'],
    ['untracked', { untracked: 1, clean: false }, 'main ?1'],
    ['ahead', { ahead: 2 }, 'main ↑2'],
  ])('draws %s with git’s own mark', (_label, over, expected) => {
    expect(gitLabel(on(over))).toBe(expected)
  })

  it('orders history before the working tree', () => {
    // ↑ is where the branch sits against its upstream; the other three are the
    // tree in front of you. Mixing the order would read as one list of four.
    expect(
      gitLabel(on({ ahead: 2, staged: 1, modified: 3, untracked: 4, clean: false })),
    ).toBe('main ↑2 +1 ~3 ?4')
  })

  it('counts a path in both columns when git does', () => {
    // `MM` is staged and then edited again. The marks have to add up to what
    // `git status --short` prints, or the field disagrees with the terminal
    // sitting next to it.
    expect(gitLabel(on({ staged: 1, modified: 1, clean: false }))).toBe('main +1 ~1')
  })

  it('names a detached head rather than printing an empty branch', () => {
    expect(gitLabel(on({ branch: null }))).toBe(DETACHED)
    expect(gitLabel(on({ branch: null, modified: 1, clean: false }))).toBe(
      `${DETACHED} ~1`,
    )
  })

  it('draws no mark for a count of zero or an absent upstream', () => {
    // `ahead: 0` is a real answer — there IS an upstream and the branch matches
    // it — and it must not draw `↑0`. Distinct from `null`, which is no upstream.
    expect(gitLabel(on({ ahead: 0 }))).toBe('main')
    expect(gitLabel(on({ ahead: null }))).toBe('main')
  })

  it('does not contradict itself when clean disagrees with the counts', () => {
    // `clean` is derived from the raw porcelain output and the counts from
    // parsing it, so they could in principle disagree. The marks win: they are
    // the more specific claim, and drawing "clean" over a counted change would
    // be the field lying rather than being vague.
    expect(gitLabel(on({ clean: true, modified: 2 }))).toBe('main ~2')
  })
})
