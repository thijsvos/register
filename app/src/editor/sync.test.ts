import { describe, expect, it } from 'vitest'
import { minimalChange } from './sync'

/** Apply a diff the way CodeMirror's ChangeSet would, to prove it reconstructs. */
function apply(previous: string, change: ReturnType<typeof minimalChange>): string {
  if (change === null) return previous
  return previous.slice(0, change.from) + change.insert + previous.slice(change.to)
}

describe('minimalChange', () => {
  it('is null when nothing moved', () => {
    expect(minimalChange('same', 'same')).toBeNull()
  })

  it.each([
    ['append', 'alpha bravo', 'alpha bravo charlie'],
    ['prepend', 'bravo charlie', 'alpha bravo charlie'],
    ['insert in the middle', 'alpha charlie', 'alpha bravo charlie'],
    ['delete from the middle', 'alpha bravo charlie', 'alpha charlie'],
    ['replace in the middle', 'alpha bravo charlie', 'alpha BRAVO charlie'],
    ['empty to full', '', 'alpha'],
    ['full to empty', 'alpha', ''],
    ['whole rewrite', 'alpha', 'omega'],
    ['a repeated run', 'aaa', 'aaaa'],
    ['a repeated run shrinking', 'aaaa', 'aaa'],
    ['trailing newline added', 'alpha', 'alpha\n'],
    [
      'frontmatter timestamp',
      '---\nmodified: A\n---\nbody',
      '---\nmodified: B\n---\nbody',
    ],
  ])('reconstructs %s exactly', (_case, previous, next) => {
    expect(apply(previous, minimalChange(previous, next))).toBe(next)
  })

  it('touches only what changed', () => {
    const previous = 'alpha bravo charlie'
    const change = minimalChange(previous, 'alpha BRAVO charlie')

    // Not a whole-document replace: that is what destroys the caret, the
    // selection and the scroll position when an agent rewrites a file.
    expect(change).toEqual({ from: 6, to: 11, insert: 'BRAVO' })
  })

  it('reports an append as an insertion at the end, touching nothing before it', () => {
    const change = minimalChange('alpha\n', 'alpha\nbravo\n')
    expect(change?.from).toBe(6)
    expect(change?.to).toBe(6)
  })

  it('does not run the suffix scan back past the prefix', () => {
    // Prefix and suffix both want the same 'a's; overlapping would produce a
    // negative-length range and a corrupt document.
    const change = minimalChange('aa', 'aaa')
    expect(change).not.toBeNull()
    expect(change?.to).toBeGreaterThanOrEqual(change?.from ?? 0)
    expect(apply('aa', change)).toBe('aaa')
  })

  it.each([
    ['emoji appended', 'note ', 'note 🙂'],
    ['emoji removed', 'note 🙂', 'note '],
    ['emoji swapped', 'a🙂b', 'a🙃b'],
    ['emoji run extended', '🙂🙂', '🙂🙂🙂'],
  ])('never splits a surrogate pair: %s', (_case, previous, next) => {
    const change = minimalChange(previous, next)
    expect(apply(previous, change)).toBe(next)
    // A boundary inside a pair would leave a lone surrogate behind.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(apply(previous, change))).toBe(false)
  })

  it('handles a realistic agent append to a long note', () => {
    const body = `${'word '.repeat(5000)}\n`
    const change = minimalChange(body, `${body}appended by an agent\n`)

    // The whole point: an edit at the end must not report as a change from 0,
    // which would scroll a reader back to the top of a 5000-word note.
    expect(change?.from).toBe(body.length)
    expect(change?.insert).toBe('appended by an agent\n')
  })
})
