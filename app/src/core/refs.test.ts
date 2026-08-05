import { describe, expect, it } from 'vitest'
import { fields } from './frontmatter'
import { newNote, notePath, slug } from './refs'

// Ref allocation is the server's (src/vault.rs::next_ref) — it is the only side
// that can see `.register/trash/` and therefore the only side that knows which
// refs have ever been used. Its tests live in src/vault/tests.rs.

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
