import { describe, expect, it } from 'vitest'
import {
  folders,
  isConflictCopy,
  isContract,
  isDaily,
  isDerived,
  isListed,
  isTemplate,
  resolveSrc,
} from './paths'

const CONFLICT = 'notes/003-a.conflict-20260805T101500000Z.md'

describe('the four kinds of file a vault holds', () => {
  it.each([
    ['notes/003-terminal.md', true, true],
    ['000-inbox.md', true, true],
    // The journal: hidden from the INDEX because there is one per day forever
    // and `daily/` sorts above `notes/`, but counted, because its tasks are the
    // ones people actually write. This pair is why listed and derived stopped
    // being nested — no other kind of file wants hidden-and-counted.
    ['daily/2026-08-05.md', false, true],
    // Furniture: real files, edited deliberately, but not notes.
    ['CLAUDE.md', false, false],
    ['templates/daily.md', false, false],
    ['templates/nested/weekly.md', false, false],
    // An artefact is listed — the index is the only place you would find one —
    // and derived from by nothing, because its lines belong to the original.
    [CONFLICT, true, false],
  ])('%s → listed %s, derived %s', (path, listed, derivedFrom) => {
    expect(isListed(path)).toBe(listed)
    expect(isDerived(path)).toBe(derivedFrom)
  })

  it('only matches the contract at the vault root', () => {
    expect(isContract('CLAUDE.md')).toBe(true)
    // A note that happens to be about the contract is still a note.
    expect(isContract('notes/007-claude-md.md')).toBe(false)
    expect(isListed('notes/007-claude-md.md')).toBe(true)
  })

  it('does not mistake a folder that merely ends in templates', () => {
    expect(isTemplate('my-templates/daily.md')).toBe(false)
    expect(isTemplate('notes/003-templates.md')).toBe(false)
  })

  it('spots a conflict copy wherever it sits', () => {
    expect(isConflictCopy(CONFLICT)).toBe(true)
    expect(isConflictCopy('notes/003-a.md')).toBe(false)
  })

  it('does not mistake a folder that merely ends in daily', () => {
    expect(isDaily('my-daily/2026-08-05.md')).toBe(false)
    expect(isDaily('notes/003-daily-habits.md')).toBe(false)
    expect(isListed('notes/003-daily-habits.md')).toBe(true)
  })

  it('keeps listed and derived independent, which is the point', () => {
    // Every combination is reachable, and each has an owner. Written as
    // `isListed && !isConflictCopy` the third row is unexpressible, and a daily
    // log would have to be either visible in the index or absent from TODAY.
    const kinds: [string, boolean, boolean][] = [
      ['notes/003-a.md', true, true], // shown and counted
      ['CLAUDE.md', false, false], // hidden and uncounted
      ['daily/2026-08-05.md', false, true], // hidden and counted
      [CONFLICT, true, false], // shown and uncounted
    ]
    for (const [path, listed, derivedFrom] of kinds) {
      expect([isListed(path), isDerived(path)], path).toEqual([listed, derivedFrom])
    }
  })
})

describe('folders', () => {
  it('names the directories a note sits in, outermost first', () => {
    expect(folders('notes/archive/018-old.md')).toEqual(['notes', 'archive'])
  })

  it('names nothing for a note at the vault root', () => {
    expect(folders('000-inbox.md')).toEqual([])
  })

  it('does not compact the way the tree does', () => {
    // The INDEX draws `projects/apollo` as one row because a level offering no
    // choice does not earn indentation. A crumb answers "where is this file",
    // and eliding a real folder would make that answer wrong to save characters.
    expect(folders('notes/projects/apollo/010-launch.md')).toEqual([
      'notes',
      'projects',
      'apollo',
    ])
  })

  it('survives a path someone else wrote', () => {
    expect(folders('a//b.md')).toEqual(['a'])
    expect(folders('')).toEqual([])
  })
})

describe('resolveSrc', () => {
  it('resolves a bare name against the note’s own folder', () => {
    expect(resolveSrc('notes/001-a.md', 'diagram.png')).toBe('notes/diagram.png')
    expect(resolveSrc('notes/archive/018-old.md', 'diagram.png')).toBe(
      'notes/archive/diagram.png',
    )
  })

  it('treats a leading slash as the vault root', () => {
    expect(resolveSrc('notes/archive/018-old.md', '/assets/logo.png')).toBe(
      'assets/logo.png',
    )
  })

  it('resolves .. rather than sending it to a server that refuses it', () => {
    expect(resolveSrc('notes/projects/010-launch.md', '../shared/plan.png')).toBe(
      'notes/shared/plan.png',
    )
    expect(resolveSrc('notes/001-a.md', './diagram.png')).toBe('notes/diagram.png')
  })

  it('refuses anything that climbs out of the vault', () => {
    // Not clamped to the root: silently resolving an escape would turn a wrong
    // link into a different wrong link, and the server refuses it anyway.
    expect(resolveSrc('notes/001-a.md', '../../etc/passwd')).toBeNull()
    expect(resolveSrc('000-inbox.md', '../secrets.png')).toBeNull()
  })

  it('refuses anything with a scheme, which the CSP would refuse too', () => {
    for (const remote of [
      'https://example.com/x.png',
      'http://example.com/x.png',
      'data:image/png;base64,AAAA',
      '//example.com/x.png',
    ]) {
      expect(resolveSrc('notes/001-a.md', remote), remote).toBeNull()
    }
  })

  it('refuses an empty or root-only reference', () => {
    expect(resolveSrc('notes/001-a.md', '')).toBeNull()
    expect(resolveSrc('notes/001-a.md', '   ')).toBeNull()
    expect(resolveSrc('notes/001-a.md', '/')).toBeNull()
  })

  it('resolves against a note at the vault root', () => {
    expect(resolveSrc('000-inbox.md', 'shot.png')).toBe('shot.png')
    expect(resolveSrc('000-inbox.md', 'assets/shot.png')).toBe('assets/shot.png')
  })
})
