import { describe, expect, it } from 'vitest'
import {
  fields,
  hasFrontmatter,
  join,
  list,
  split,
  touchModified,
  wordCount,
} from './frontmatter'

const NOTE = [
  '---',
  'id: 01J2ZK7Q8W3E5R9T',
  'ref: 003',
  'title: Terminal aesthetics',
  'created: 2026-07-28',
  'modified: 2026-08-04T13:47:00Z',
  'tags: [design, research]',
  '---',
  'Body is plain markdown.',
  '',
].join('\n')

describe('split / join', () => {
  it.each([
    ['a normal note', NOTE],
    ['no frontmatter', 'Just a body.\n'],
    ['CRLF line endings', '---\r\ntitle: A\r\n---\r\nBody\r\n'],
    ['a byte-order mark', `\u{feff}${NOTE}`],
    ['an unterminated fence', '---\ntitle: A\nnever closed\n'],
    ['empty frontmatter', '---\n---\nBody\n'],
    ['a horizontal rule in the body', '---\ntitle: A\n---\nBefore\n\n---\n\nAfter\n'],
    ['no trailing newline', '---\ntitle: A\n---\nBody'],
    ['an empty file', ''],
  ])('round-trips %s byte for byte', (_case, source) => {
    // §04's compatibility contract turns on this: the UI must not churn a file
    // an agent just formatted.
    expect(join(split(source))).toBe(source)
  })

  it('does not treat a body rule as the closing fence', () => {
    const parts = split('---\ntitle: A\n---\nBefore\n\n---\n\nAfter\n')
    expect(parts.yaml).toBe('title: A\n')
    expect(parts.body).toBe('Before\n\n---\n\nAfter\n')
  })

  it('rejects an unterminated fence rather than swallowing the file', () => {
    expect(hasFrontmatter('---\ntitle: A\nnever closed\n')).toBe(false)
  })
})

describe('touchModified', () => {
  it('rewrites only the modified value', () => {
    const next = touchModified(NOTE, '2026-08-05T09:16:40Z')

    expect(next).toContain('modified: 2026-08-05T09:16:40Z')
    // Every other byte is identical — proven by putting the old value back.
    expect(touchModified(next, '2026-08-04T13:47:00Z')).toBe(NOTE)
  })

  it('preserves key order and the spacing around the value', () => {
    const odd = '---\ntags: [a]\nmodified:    old\ntitle: A\n---\nBody\n'
    expect(touchModified(odd, 'NEW')).toBe(
      '---\ntags: [a]\nmodified:    NEW\ntitle: A\n---\nBody\n',
    )
  })

  it('never rewrites a nested modified key', () => {
    // An agent writing structured frontmatter must not have its data mangled
    // the first time a human types in the note.
    const nested =
      '---\nid: X\nsource:\n  modified: 2026-01-01\ntitle: T\nmodified: old\n---\nbody'
    expect(touchModified(nested, 'NEW')).toBe(
      '---\nid: X\nsource:\n  modified: 2026-01-01\ntitle: T\nmodified: NEW\n---\nbody',
    )
  })

  it('never rewrites modified inside a block scalar', () => {
    const scalar = '---\nnote: |\n  modified: keep this prose\nmodified: old\n---\nbody'
    expect(touchModified(scalar, 'NEW')).toBe(
      '---\nnote: |\n  modified: keep this prose\nmodified: NEW\n---\nbody',
    )
  })

  it('adds a top-level field when only a nested one exists', () => {
    const nested = '---\nsource:\n  modified: 2026-01-01\n---\nbody'
    const next = touchModified(nested, 'NEW')
    expect(next).toContain('  modified: 2026-01-01')
    expect(next).toContain('\nmodified: NEW\n')
  })

  it('adds the field when it is missing', () => {
    const next = touchModified('---\ntitle: A\n---\nBody\n', 'NEW')
    expect(next).toBe('---\ntitle: A\nmodified: NEW\n---\nBody\n')
  })

  it('leaves a note without frontmatter completely alone', () => {
    const bare = 'Just a body.\n'
    expect(touchModified(bare, 'NEW')).toBe(bare)
  })

  it('keeps a byte-order mark', () => {
    const next = touchModified(`\u{feff}${NOTE}`, 'NEW')
    expect(next.startsWith('\u{feff}---')).toBe(true)
  })
})

describe('fields', () => {
  it('reads the flat scalars', () => {
    const read = fields(NOTE)
    expect(read.get('ref')).toBe('003')
    expect(read.get('title')).toBe('Terminal aesthetics')
    expect(read.get('modified')).toBe('2026-08-04T13:47:00Z')
  })

  it('keeps a zero-padded ref a string', () => {
    expect(fields(NOTE).get('ref')).toBe('003')
  })

  it('is empty for a note without frontmatter', () => {
    expect(fields('Body only\n').size).toBe(0)
  })
})

describe('list', () => {
  it.each([
    ['[design, research]', ['design', 'research']],
    ['design, research', ['design', 'research']],
    ['[]', []],
    ['', []],
    ['["quoted", other]', ['quoted', 'other']],
  ])('parses %s', (input, expected) => {
    expect(list(input)).toEqual(expected)
  })

  it('is empty for a missing value', () => {
    expect(list(undefined)).toEqual([])
  })
})

describe('wordCount', () => {
  it('counts the body and ignores frontmatter', () => {
    expect(wordCount(NOTE)).toBe(4)
  })

  it('is zero for an empty body', () => {
    expect(wordCount('---\ntitle: A\n---\n')).toBe(0)
  })
})
