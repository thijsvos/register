import { describe, expect, it } from 'vitest'
import { isConflictCopy, isContract, isDerived, isListed, isTemplate } from './paths'

const CONFLICT = 'notes/003-a.conflict-20260805T101500000Z.md'

describe('the three kinds of file a vault holds', () => {
  it.each([
    ['notes/003-terminal.md', true, true],
    ['000-inbox.md', true, true],
    ['daily/2026-08-05.md', true, true],
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
})
