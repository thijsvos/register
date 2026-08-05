import { describe, expect, it } from 'vitest'
import { fields } from './frontmatter'
import { newNote, nextRef, notePath, slug } from './refs'

describe('nextRef', () => {
  it('is highest plus one, not count plus one', () => {
    // §04 makes a ref immutable, so a deleted 004 must never be reissued.
    expect(nextRef(['001', '002', '004'])).toBe('005')
  })

  it('starts at 000 for an empty vault', () => {
    expect(nextRef([])).toBe('000')
  })

  it('keeps zero padding and widens when the vault does', () => {
    expect(nextRef(['001'])).toBe('002')
    expect(nextRef(['0999'])).toBe('1000')
    expect(nextRef(['999'])).toBe('1000')
  })

  it('ignores notes with no ref', () => {
    expect(nextRef([null, '003', null])).toBe('004')
  })

  it('ignores refs that are not numbers', () => {
    expect(nextRef(['003', 'draft'])).toBe('004')
  })

  it('is monotonic across repeated allocation', () => {
    const refs: string[] = []
    for (let i = 0; i < 25; i++) refs.push(nextRef(refs))
    expect(refs).toEqual([...refs].sort())
    expect(new Set(refs).size).toBe(refs.length)
  })
})

describe('slug', () => {
  it.each([
    ['Terminal aesthetics', 'terminal-aesthetics'],
    ['Terminal  aesthetics!', 'terminal-aesthetics'],
    ['  Leading and trailing  ', 'leading-and-trailing'],
    ['Café notes', 'cafe-notes'],
    ['C++ vs Rust', 'c-vs-rust'],
    ['???', 'untitled'],
    ['', 'untitled'],
  ])('%s -> %s', (title, expected) => {
    expect(slug(title)).toBe(expected)
  })
})

describe('notePath', () => {
  it('follows §04: filename = ref-slug', () => {
    expect(notePath('003', 'Terminal aesthetics')).toBe(
      'notes/003-terminal-aesthetics.md',
    )
  })
})

describe('newNote', () => {
  const now = new Date('2026-08-05T09:16:40.123Z')

  it('writes every field §04 requires', () => {
    const read = fields(newNote({ ref: '003', title: 'Terminal aesthetics', now }))

    expect(read.get('id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(read.get('ref')).toBe('003')
    expect(read.get('title')).toBe('Terminal aesthetics')
    expect(read.get('created')).toBe('2026-08-05')
    expect(read.get('modified')).toBe('2026-08-05T09:16:40Z')
    expect(read.get('tags')).toBe('[]')
  })

  it('keeps a zero-padded ref padded rather than turning it into a number', () => {
    expect(newNote({ ref: '003', title: 'A', now })).toContain('ref: 003')
  })

  it('produces a note the splitter accepts', () => {
    const note = newNote({ ref: '000', title: 'Inbox', now })
    expect(note.startsWith('---\n')).toBe(true)
    expect(note).toContain('\n---\n')
  })
})
