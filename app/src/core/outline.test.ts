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
