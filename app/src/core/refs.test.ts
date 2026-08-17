import { describe, expect, it } from 'vitest'
import { fields, split } from './frontmatter'
import { isTemplate } from './paths'
import { dailyFrom, newNote, noteFrom, notePath, slug } from './refs'

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
    // Any script, not only Latin — the same rows `scaffold/tests.rs` holds, so
    // one title cannot name two different files.
    ['Заметки', 'заметки'],
    ['設計ノート', '設計ノート'],
    ['Ελληνικά', 'ελληνικά'],
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

describe('a title YAML cannot read plainly', () => {
  // The server's `yaml_scalar` in src/scaffold.rs is the same rule, because a
  // note created here and one created by `register new` have to be one file.
  // Splicing the title in raw is not a cosmetic slip: a bare `: ` makes the
  // whole frontmatter block a syntax error, so the note loses its title *and*
  // its tags in the INDEX and the tag index, silently.
  it.each([
    'Rust: a survey',
    'trailing colon:',
    'a # hash',
    '[bracketed]',
    '- dashed',
    'quote " inside',
    'back\\slash',
  ])('survives being written and read back: %s', (title) => {
    const note = newNote({ ref: '003', title, now: new Date('2026-08-05T09:16:40Z') })
    expect(fields(note).get('title')).toBe(title)
  })

  it('leaves an unremarkable title unquoted', () => {
    // §04's examples are unquoted, and a vault should read like something a
    // person wrote by hand.
    const note = newNote({ ref: '003', title: 'Terminal aesthetics', now: new Date() })
    expect(note).toContain('title: Terminal aesthetics\n')
  })
})

describe('isTemplate', () => {
  it.each([
    ['templates/daily.md', true],
    ['templates/nested/weekly.md', true],
    ['notes/003-templates.md', false],
    ['daily/2026-08-05.md', false],
    ['my-templates/daily.md', false],
  ])('%s -> %s', (path, expected) => {
    expect(isTemplate(path)).toBe(expected)
  })
})

describe('noteFrom', () => {
  const now = new Date('2026-08-05T09:16:40.123Z')
  const options = { ref: '007', title: 'Weekly review', now }

  const TEMPLATE = [
    '---',
    'id: TEMPLATE',
    'ref: TEMPLATE',
    'title: TEMPLATE',
    'created: TEMPLATE',
    'modified: TEMPLATE',
    'tags: [review, weekly]',
    'status: draft',
    '---',
    '# Weekly review',
    '',
    '- [ ] read the log',
  ].join('\n')

  it('falls back to a bare note when there is no template', () => {
    expect(noteFrom(null, { ...options, id: 'PINNED' })).toBe(
      newNote({ ...options, id: 'PINNED' }),
    )
  })

  it('stamps the five per-note fields and leaves everything else alone', () => {
    const read = fields(noteFrom(TEMPLATE, options))

    expect(read.get('id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(read.get('ref')).toBe('007')
    expect(read.get('title')).toBe('Weekly review')
    expect(read.get('created')).toBe('2026-08-05')
    expect(read.get('modified')).toBe('2026-08-05T09:16:40Z')
    // The template author's own fields survive untouched.
    expect(read.get('tags')).toBe('[review, weekly]')
    expect(read.get('status')).toBe('draft')
  })

  it('keeps the template body byte for byte', () => {
    expect(split(noteFrom(TEMPLATE, options)).body).toBe(split(TEMPLATE).body)
  })

  it('gives a body-only template a conforming header', () => {
    const built = noteFrom('Just prose.\n', options)
    expect(fields(built).get('ref')).toBe('007')
    expect(split(built).body).toBe('Just prose.\n')
  })

  it('adds tags when the template declares none', () => {
    const bare = '---\ntitle: x\n---\nbody\n'
    expect(fields(noteFrom(bare, options)).get('tags')).toBe('[]')
  })

  it('survives a title the replacement syntax would otherwise eat', () => {
    // `$1` and `$&` are syntax in a replacement string. A title carrying them
    // must land as text, not splice the matched key back into its own value.
    const built = noteFrom(TEMPLATE, { ...options, title: 'Costs in $1 and $& terms' })
    expect(fields(built).get('title')).toBe('Costs in $1 and $& terms')
  })
})

describe('dailyFrom', () => {
  const now = new Date('2026-08-05T09:16:40.123Z')

  it('titles and dates the note for the day', () => {
    const read = fields(
      dailyFrom('---\nid: T\ntitle: T\ncreated: T\nmodified: T\n---\n', now),
    )

    expect(read.get('title')).toBe('2026-08-05')
    expect(read.get('created')).toBe('2026-08-05')
    expect(read.get('modified')).toBe('2026-08-05T09:16:40Z')
    expect(read.get('id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('never gives a daily log a ref', () => {
    // §04: daily logs have their own filename shape, and a date is not a ref —
    // the server's allocator skips daily/ for exactly that reason.
    expect(fields(dailyFrom('---\ntitle: T\n---\n', now)).has('ref')).toBe(false)
    expect(fields(dailyFrom(null, now)).has('ref')).toBe(false)
  })

  it('defaults the tag to daily but keeps the template’s own', () => {
    expect(fields(dailyFrom('---\ntitle: T\n---\n', now)).get('tags')).toBe('[daily]')
    expect(fields(dailyFrom('---\ntags: [log]\n---\n', now)).get('tags')).toBe('[log]')
  })

  it('keeps the template body, which is the whole point of a template', () => {
    const template = '---\ntitle: T\n---\n## Log\n\n- [ ] \n'
    expect(split(dailyFrom(template, now)).body).toBe('## Log\n\n- [ ] \n')
  })
})
