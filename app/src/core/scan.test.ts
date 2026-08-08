import { describe, expect, it } from 'vitest'
import { bodyLines } from './scan'

/**
 * `bodyLines` is shared so the outline and the task list cannot disagree about
 * what a fenced block is — the module's own docstring names the drift it
 * prevents: "a `# note` in a shell snippet becoming a heading, or a `- [ ]` in a
 * code sample becoming something the vault says you have to do."
 *
 * It had no direct test. `outline.test.ts` and `tasks.test.ts` reach it through
 * their own consumers, which covers the common cases and leaves the fence-closing
 * rules and the offset arithmetic invisible: consumers only ever observe content
 * lines, so `fenced` on the fence lines themselves is unobservable there, and an
 * off-by-one in `from` shows up as a caret in the wrong place rather than a
 * failing assertion.
 */

/** The lines a consumer would act on — everything not inside a fence. */
function live(source: string): string[] {
  return bodyLines(source)
    .filter((line) => !line.fenced)
    .map((line) => line.text)
}

const NOTE = ['---', 'ref: 003', 'title: A', '---', ''].join('\n')

describe('bodyLines fence handling', () => {
  it('treats the opening and closing fences as fenced themselves', () => {
    // Invisible through `outline`/`tasksIn`, which only ever read content — so
    // this is the only place the flag on the fence lines is checked at all.
    const lines = bodyLines('before\n```\ninside\n```\nafter\n')
    expect(lines.map((line) => line.fenced)).toEqual([
      false, // before
      true, // ```
      true, // inside
      true, // ```
      false, // after
      false, // trailing empty line
    ])
  })

  it('closes only on the same fence character', () => {
    // A `~~~` cannot close a ``` block, so everything between stays code.
    expect(live('```\n# not a heading\n~~~\n- [ ] not a task\n```\ndone\n')).toEqual([
      'done',
      '',
    ])
  })

  it('closes only on a fence at least as long as the opener', () => {
    // CommonMark: a shorter run is content. Without this a ``` line inside a
    // ````-fenced block would end the block early and expose the rest.
    expect(live('````\n```\n# still code\n````\nout\n')).toEqual(['out', ''])
  })

  it('accepts a longer closer than the opener', () => {
    expect(live('```\ncode\n`````\nout\n')).toEqual(['out', ''])
  })

  it('treats a closer carrying an info string as content, not a closer', () => {
    // ```` ```sh ```` opens; a later ```` ```sh ```` does not close.
    expect(live('```\ncode\n```sh\n# still code\n```\nout\n')).toEqual(['out', ''])
  })

  it('allows up to three spaces of indent on a fence, and no more', () => {
    expect(live('   ```\n# code\n   ```\nout\n')).toEqual(['out', ''])
    // Four spaces is an indented code block in CommonMark, not a fence — so
    // this scanner does not treat it as one, and the line stays content.
    expect(live('    ```\n# heading\n')).toEqual(['    ```', '# heading', ''])
  })

  it('runs an unclosed fence to the end rather than swallowing the file', () => {
    expect(live('intro\n```\nnever closed\n# not a heading\n')).toEqual(['intro'])
  })

  it('reopens after a closed block', () => {
    expect(live('a\n```\nx\n```\nb\n```\ny\n```\nc\n')).toEqual(['a', 'b', 'c', ''])
  })
})

describe('bodyLines offsets', () => {
  it('points at the first character of each line in the whole source', () => {
    const source = 'one\ntwo\nthree\n'
    for (const line of bodyLines(source)) {
      expect(source.slice(line.from, line.from + line.text.length)).toBe(line.text)
    }
  })

  it('counts the frontmatter it excludes, so an offset splices back correctly', () => {
    // The offsets go straight to the editor's `reveal()`. An off-by-one here
    // puts the caret in the wrong byte of the real file.
    const source = `${NOTE}Body line.\nSecond.\n`
    for (const line of bodyLines(source)) {
      expect(source.slice(line.from, line.from + line.text.length)).toBe(line.text)
    }
    expect(bodyLines(source)[0]?.from).toBe(NOTE.length)
  })

  it('stays byte-exact across CRLF, where the reported text drops the return', () => {
    const source = 'one\r\ntwo\r\n'
    const lines = bodyLines(source)
    expect(lines.map((line) => line.text)).toEqual(['one', 'two', ''])
    // `from` counts the \r even though `text` does not carry it.
    expect(lines[1]?.from).toBe(5)
    expect(source.slice(5, 8)).toBe('two')
  })

  it('counts a byte-order mark', () => {
    const source = `﻿${NOTE}Body.\n`
    const first = bodyLines(source)[0]
    expect(first?.text).toBe('Body.')
    expect(source.slice(first?.from ?? 0, (first?.from ?? 0) + 5)).toBe('Body.')
  })

  it('returns one empty line for an empty source rather than nothing', () => {
    // `split('\n')` on '' yields ['']. Consumers iterate the result, so zero
    // lines and one empty line are different shapes — pinned so a future
    // "simplification" to `[]` has to be deliberate.
    expect(bodyLines('')).toEqual([{ text: '', from: 0, fenced: false }])
  })
})
