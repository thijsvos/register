import { describe, expect, it } from 'vitest'
import {
  fields,
  hasFrontmatter,
  join as rejoin,
  split,
  touchModified,
} from './frontmatter'

/**
 * The client half of §09 layer 4, over the same frozen bytes the Rust side reads.
 *
 * §04 has two parsers in two languages and nothing used to compare them. They
 * had already drifted: `src/vault.rs` opened on a byte-exact `---\n` while this
 * side allowed `/^---[ \t]*\r?\n/`, so `notes/004-loose-fence.md` was a note here
 * and metadata-less there. The fix was to make the server say what this file
 * says; the point of *this* test is that the next drift is a failure rather than
 * a discovery.
 *
 * `tests/compat.rs` asserts the same fixture from the server's side, and the two
 * files name the same notes on purpose. If you change one, change the other.
 */

/**
 * The fixture, read the way `doctrine.test.ts` reads the stylesheets.
 *
 * `import.meta.glob` rather than `node:fs`, for two reasons: `@types/node` is a
 * dependency this repository does not have and rule 6 puts behind an ADR, and
 * the glob is resolved at transform time so a fixture file that goes missing is
 * a build error rather than a test that quietly stops covering anything.
 */
const PREFIX = '../../../tests/fixtures/vault-v1/'
const FILES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob('../../../tests/fixtures/vault-v1/**/*.md', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).map(([path, text]) => [path.slice(PREFIX.length), text]),
)

function bytes(rel: string): string {
  const found = FILES[rel]
  if (found === undefined) throw new Error(`no such fixture note: ${rel}`)
  return found
}

/**
 * Every note in the fixture, discovered rather than listed.
 *
 * So a note added to the fixture later is covered without anyone remembering to
 * add a case here — which is the whole reason the fixture is a directory rather
 * than another table of literals. `CLAUDE.md` is furniture, not a note.
 */
function everyNote(): string[] {
  return Object.keys(FILES)
    .filter((rel) => rel !== 'CLAUDE.md' && !rel.startsWith('.register/'))
    .sort()
}

describe('the fixture is what it claims to be', () => {
  it('still carries the oddities it exists for', () => {
    // The non-vacuity control. Every assertion below is about reading strange
    // bytes; if someone reformatted the fixture they would all pass against
    // ordinary ones and prove nothing.
    expect(bytes('notes/004-loose-fence.md').startsWith('--- \n')).toBe(true)
    expect(bytes('notes/005-crlf.md').startsWith('---\r\n')).toBe(true)
    expect(bytes('notes/006-bom.md').startsWith('﻿')).toBe(true)
    expect(bytes('notes/010-no-newline.md').endsWith('\n')).toBe(false)
    expect(bytes('notes/008-duplicate-key.md').match(/^title:/gm)).toHaveLength(2)
    expect(bytes('notes/011-loose-close.md')).toContain('---  \n')
  })
})

describe('split round-trips every note in the fixture', () => {
  // §04's central clause: "byte-lossless outside frontmatter `modified`". This
  // is the whole vault rather than a table of literals, so a note added to the
  // fixture later is covered without anyone remembering to add a case.
  it.each(everyNote())('%s survives split → join unchanged', (rel) => {
    const source = bytes(rel)
    expect(rejoin(split(source))).toBe(source)
  })
})

describe('the client reads what the server reads', () => {
  // The same list as `tests/compat.rs`. Both parsers must agree about which of
  // these files carry frontmatter at all — that is the exact thing that drifted.
  const WITH_FRONTMATTER = [
    'notes/003-terminal-aesthetics.md',
    'notes/004-loose-fence.md',
    'notes/005-crlf.md',
    'notes/006-bom.md',
    'notes/007-unknown-keys.md',
    'notes/008-duplicate-key.md',
    'notes/0009-wide-ref.md',
    'notes/010-no-newline.md',
    'notes/011-loose-close.md',
    '000-inbox.md',
  ]

  it.each(WITH_FRONTMATTER)('%s has frontmatter', (rel) => {
    expect(hasFrontmatter(bytes(rel))).toBe(true)
  })

  it('reads the title through a fence with a trailing space', () => {
    expect(fields(bytes('notes/004-loose-fence.md')).get('title')).toBe('Loose fence')
  })

  it('reads the title through CRLF', () => {
    expect(fields(bytes('notes/005-crlf.md')).get('title')).toBe('Written on Windows')
  })

  it('reads the title through a byte order mark', () => {
    expect(fields(bytes('notes/006-bom.md')).get('title')).toBe('Byte order mark')
  })
})

describe('a save changes one line and nothing else', () => {
  // The §04 promise stated as bytes rather than as a property of two pure
  // functions: `touchModified` is what the save pipeline actually calls, and
  // what it must not disturb is everything else in the file.
  const STAMP = '2026-09-01T12:00:00Z'

  it.each(everyNote().filter((rel) => rel !== 'templates/daily.md'))(
    '%s differs only in its modified line',
    (rel) => {
      const before = bytes(rel)
      const after = touchModified(before, STAMP)

      const changed = before
        .split('\n')
        .map((line, at) => [line, after.split('\n')[at]] as const)
        .filter(([one, other]) => one !== other)

      expect(changed.every(([one]) => one.startsWith('modified:'))).toBe(true)
      expect(changed.length).toBeLessThanOrEqual(1)
    },
  )

  it('keeps a byte order mark, its line endings, and the absence of a final newline', () => {
    const bom = touchModified(bytes('notes/006-bom.md'), STAMP)
    expect(bom.startsWith('﻿')).toBe(true)

    const crlf = touchModified(bytes('notes/005-crlf.md'), STAMP)
    expect(crlf.startsWith('---\r\n')).toBe(true)
    expect(crlf).toContain(`modified: ${STAMP}\r\n`)

    const bare = touchModified(bytes('notes/010-no-newline.md'), STAMP)
    expect(bare.endsWith('\n')).toBe(false)
  })

  it('leaves unknown keys and comments exactly where they were', () => {
    const after = touchModified(bytes('notes/007-unknown-keys.md'), STAMP)
    expect(after).toContain('status: draft')
    expect(after).toContain('aliases: [alias-one, alias-two]')
    expect(after).toContain('# a comment in the frontmatter')
  })

  it('actually rewrote something, so the assertions above are not vacuous', () => {
    const before = bytes('notes/003-terminal-aesthetics.md')
    expect(before).not.toContain(STAMP)
    expect(touchModified(before, STAMP)).toContain(`modified: ${STAMP}`)
  })
})
