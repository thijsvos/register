import { describe, expect, it } from 'vitest'
import { outline } from './outline'

const FRONT = ['---', 'id: 01J2ZK7Q8W3E5R9T', 'ref: 003', 'tags: [design]', '---'].join(
  '\n',
)

describe('outline', () => {
  it('reads ATX headings with their level and text', () => {
    const source = ['# One', 'body', '### Three', '', '###### Six'].join('\n')
    expect(outline(source).map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 1, text: 'One' },
      { level: 3, text: 'Three' },
      { level: 6, text: 'Six' },
    ])
  })

  it('offsets each heading to its own hash, frontmatter included', () => {
    const source = `${FRONT}\n# Title\n\nbody\n## Second\n`
    const found = outline(source)
    for (const heading of found) {
      expect(source.slice(heading.from, heading.from + 2)).toBe(
        heading.level === 1 ? '# ' : '##',
      )
    }
    expect(found).toHaveLength(2)
  })

  it('never reads a hashtag as a heading', () => {
    // `#design` on its own line is a tag. Without CommonMark's required space a
    // tag-heavy vault produces an outline of nonsense.
    expect(outline('#design\n#!/bin/sh\n# Real heading')).toEqual([
      { level: 1, text: 'Real heading', from: '#design\n#!/bin/sh\n'.length },
    ])
  })

  it('ignores hashes inside a fenced code block', () => {
    const source = [
      '# Real',
      '```sh',
      '# not a heading',
      '## nor this',
      '```',
      '## Also real',
    ].join('\n')
    expect(outline(source).map((h) => h.text)).toEqual(['Real', 'Also real'])
  })

  it('closes a fence only on a bare marker of the same kind', () => {
    // A ``` inside a ~~~ block is content, and a fence line carrying an info
    // string opens rather than closes.
    const source = ['~~~', '```', '# hidden', '~~~', '# visible'].join('\n')
    expect(outline(source).map((h) => h.text)).toEqual(['visible'])
  })

  it('leaves an unterminated fence open to the end of the note', () => {
    expect(outline('```\n# never a heading')).toEqual([])
  })

  it('strips a closing sequence but leaves inline markdown literal', () => {
    expect(outline('## **Bold** title ##').map((h) => h.text)).toEqual(['**Bold** title'])
  })

  it('drops a heading with nothing to show', () => {
    expect(outline('###\n#  \n# Named')).toEqual([
      { level: 1, text: 'Named', from: '###\n#  \n'.length },
    ])
  })

  it('keeps offsets exact across CRLF line endings', () => {
    const source = '# One\r\nbody\r\n## Two\r\n'
    for (const heading of outline(source)) {
      expect(source.startsWith('#', heading.from)).toBe(true)
      expect(source.slice(heading.from).startsWith(`${'#'.repeat(heading.level)} `)).toBe(
        true,
      )
    }
  })

  it('reads nothing out of an empty note', () => {
    expect(outline('')).toEqual([])
    expect(outline(`${FRONT}\n`)).toEqual([])
  })
})

describe('setext headings', () => {
  /** A note whose body starts right after the frontmatter fence. */
  const note = (body: string) => `${FRONT}\n${body}`
  /** Where that body begins, which is where the first line's offset must point. */
  const OFFSET = FRONT.length + 1

  it('reads a title underlined with equals as level 1', () => {
    expect(outline(note('Terminal aesthetics\n===================\n'))).toEqual([
      { level: 1, text: 'Terminal aesthetics', from: OFFSET },
    ])
  })

  it('reads one underlined with dashes as level 2', () => {
    const found = outline(note('Hairlines\n---------\n'))
    expect(found.map((h) => [h.level, h.text])).toEqual([[2, 'Hairlines']])
  })

  it('does not turn a horizontal rule into a heading', () => {
    // The case that decides whether this feature is worth having: `---` under a
    // paragraph is a heading, and the same three characters after a blank line
    // are a thematic break. Reading it wrong makes an outline of every rule in
    // the vault.
    expect(outline(note('Some prose.\n\n---\n\nMore prose.\n'))).toEqual([])
  })

  it('does not read a list or a quote as a heading', () => {
    // CommonMark says the content of a setext heading is a paragraph.
    expect(outline(note('- an item\n---\n'))).toEqual([])
    expect(outline(note('> a quote\n---\n'))).toEqual([])
    expect(outline(note('1. first\n---\n'))).toEqual([])
  })

  it('ignores an underline inside a fence', () => {
    expect(outline(note('```\nTitle\n=====\n```\n'))).toEqual([])
  })

  it('does not let an underline become the next heading’s text', () => {
    // Consecutive headings do not test this — `===` followed by `Two` is not an
    // underline, so the loop skips it either way. It takes two underlines in a
    // row: without consuming the first, it becomes the *content* of the second
    // and the pane grows a row reading `===`.
    expect(outline(note('One\n===\n===\n')).map((h) => h.text)).toEqual(['One'])
    expect(outline(note('One\n---\n---\n')).map((h) => h.text)).toEqual(['One'])
  })

  it('still lists two headings in a row', () => {
    const found = outline(note('One\n===\nTwo\n===\n'))
    expect(found.map((h) => h.text)).toEqual(['One', 'Two'])
  })

  it('points at the text, since there is no marker to point at', () => {
    const found = outline(note('Alpha\n=====\n'))
    expect(found[0]?.from).toBe(OFFSET)
  })

  it('lists both spellings together, in the order they appear', () => {
    const found = outline(note('# Atx one\n\nSetext two\n----------\n\n### Atx three\n'))
    expect(found.map((h) => [h.level, h.text])).toEqual([
      [1, 'Atx one'],
      [2, 'Setext two'],
      [3, 'Atx three'],
    ])
  })
})
