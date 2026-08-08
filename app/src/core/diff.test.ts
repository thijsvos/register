import { describe, expect, it } from 'vitest'
import { diffLines, merge, pending, type Row, type Side } from './diff'

/**
 * The diff behind §02b Screen 4, whose promise is "no revision is destroyed".
 *
 * That promise is a round trip: whatever the table shows, taking every row from
 * one side has to reproduce that side's file byte for byte. A diff that renders
 * plausibly but loses a blank line at the end would still look right on screen
 * and would still write a corrupted note — so most of what is asserted here is
 * the round trip rather than the row shapes.
 */

/** Choose one side for every row that needs a choice, and nothing for the rest. */
function all(rows: readonly Row[], side: Side): (Side | undefined)[] {
  return rows.map((row) => (row.kind === 'change' ? side : undefined))
}

/** Both revisions of a note, and what the pair is there to catch. */
const PAIRS: [string, string, string][] = [
  ['same\n', 'same\n', 'identical'],
  ['', '', 'both empty'],
  ['', 'added\n', 'local empty'],
  ['gone\n', '', 'disk empty'],
  ['a\nb\nc\n', 'a\nB\nc\n', 'one line changed in the middle'],
  ['a\nb\nc\n', 'a\nb\nc\nd\n', 'appended'],
  ['a\nb\nc\n', 'c\nb\na\n', 'reordered'],
  ['a\n', 'a\na\n', 'a repeat, where prefix and suffix want the same line'],
  ['x\ny\nz\n', 'q\nr\ns\n', 'nothing in common'],
  ['a\n\n\nb\n', 'a\nb\n', 'blank lines removed'],
  ['keep\n', 'keep', 'a trailing newline is the only difference'],
  ['one\ntwo\nthree\nfour\n', 'one\nTWO\nthree\nFOUR\n', 'two separate edits'],
]

describe('diffLines round-trips', () => {
  for (const [local, disk, what] of PAIRS) {
    it(`reproduces both sides — ${what}`, () => {
      const rows = diffLines(local, disk)
      expect(merge(rows, all(rows, 'local'))).toBe(local)
      expect(merge(rows, all(rows, 'disk'))).toBe(disk)
    })
  }

  it('would fail if a trailing newline were dropped', () => {
    // The positive control for the case above: `split('\n')` keeps a trailing
    // newline as a final empty line, and a diff that trimmed it would round-trip
    // every other pair in the table and silently truncate every real note.
    const rows = diffLines('keep\n', 'keep')
    expect(merge(rows, all(rows, 'local'))).not.toBe('keep')
    expect(rows.at(-1)).toEqual({ kind: 'change', local: '', disk: null })
  })
})

describe('diffLines rows', () => {
  it('marks agreeing lines as same, with nothing to choose', () => {
    const rows = diffLines('a\nb\n', 'a\nb\n')
    expect(rows.every((row) => row.kind === 'same')).toBe(true)
    expect(pending(rows, [])).toBe(0)
  })

  it('leaves the local side null where only disk has a line', () => {
    const rows = diffLines('a\nb\n', 'a\nnew\nb\n')
    expect(rows).toContainEqual({ kind: 'change', local: null, disk: 'new' })
  })

  it('leaves the disk side null where only local has a line', () => {
    const rows = diffLines('a\ndoomed\nb\n', 'a\nb\n')
    expect(rows).toContainEqual({ kind: 'change', local: 'doomed', disk: null })
  })

  it('pairs a replaced line rather than stacking a removal on an addition', () => {
    // The frame draws `− old` beside `+ new` on one row. Two rows with a null
    // each would render as an unrelated delete and insert, and would ask the
    // user for two decisions where the file only contains one.
    const rows = diffLines('a\nold\nb\n', 'a\nnew\nb\n')
    expect(rows).toEqual([
      { kind: 'same', local: 'a', disk: 'a' },
      { kind: 'change', local: 'old', disk: 'new' },
      { kind: 'same', local: 'b', disk: 'b' },
      { kind: 'same', local: '', disk: '' },
    ])
  })

  it('keeps agreeing lines out of the choices, however far apart they are', () => {
    // 200 identical lines with one edit in the middle is the ordinary case — an
    // agent appending to a note you are editing. If the prefix/suffix trim broke,
    // this would still round-trip and would ask for hundreds of decisions.
    const body = Array.from({ length: 200 }, (_, at) => `line ${at}`)
    const edited = [...body]
    edited[100] = 'line 100, revised'
    const rows = diffLines(`${body.join('\n')}\n`, `${edited.join('\n')}\n`)
    expect(pending(rows, [])).toBe(1)
  })
})

describe('merge', () => {
  const rows = diffLines('mine\nshared\n', 'theirs\nshared\n')

  it('refuses to build anything while a row is unchosen', () => {
    expect(pending(rows, [])).toBe(1)
    expect(merge(rows, [])).toBeNull()
  })

  it('builds once every row has a side', () => {
    // The positive control: without it, a `merge` that always returned null
    // would satisfy the assertion above forever.
    expect(merge(rows, all(rows, 'disk'))).toBe('theirs\nshared\n')
  })

  it('takes each row from its own side, not the file its neighbours came from', () => {
    const mixed = diffLines('a1\nb1\n', 'a2\nb2\n')
    const chosen = mixed.map((row, at) =>
      row.kind === 'change' ? (at === 0 ? 'local' : 'disk') : undefined,
    ) as (Side | undefined)[]
    expect(merge(mixed, chosen)).toBe('a1\nb2\n')
  })

  it('drops the line when the chosen side is the empty one', () => {
    // `∅ (empty)` in the frame. Choosing it is a decision to leave the line out,
    // not a null that should be written as a blank line.
    const cut = diffLines('a\ndoomed\nb\n', 'a\nb\n')
    expect(merge(cut, all(cut, 'disk'))).toBe('a\nb\n')
  })

  it('ignores a side offered for a row that agrees', () => {
    const agreed = diffLines('a\n', 'a\n')
    expect(merge(agreed, ['disk', 'disk'])).toBe('a\n')
  })
})

describe('pending', () => {
  it('counts only the rows that need a decision', () => {
    const rows = diffLines('a\nx\nb\ny\n', 'a\nX\nb\nY\n')
    expect(pending(rows, [])).toBe(2)
    expect(pending(rows, all(rows, 'local'))).toBe(0)
  })

  it('does not count a row already chosen, or miscount a same row as chosen', () => {
    const rows = diffLines('a\nx\n', 'a\nX\n')
    const one = rows.map((row, at) =>
      row.kind === 'change' && at === 1 ? 'local' : undefined,
    )
    expect(pending(rows, one as (Side | undefined)[])).toBe(0)
  })
})
