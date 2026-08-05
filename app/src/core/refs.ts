import { ulid } from '../lib/ulid'
import { fields, list } from './frontmatter'

/** Minimum ref width. §04's examples are three digits (`003-…`). */
const MIN_WIDTH = 3

/**
 * The next ref: §04's invariant is "highest existing + 1".
 *
 * Highest, not count, so a gap in the middle stays a gap — 001, 002, 004 yields
 * 005 and never re-issues 003.
 *
 * Deleting the highest note does free its ref, because §04 says "existing" and a
 * trashed note no longer exists — so refs are not monotonic across deletions,
 * and a later note can take a ref a wikilink already points at. That is
 * deliberate fidelity to the contract, not an oversight; the hazard is recorded
 * in docs/ROADMAP.md.
 */
export function nextRef(refs: readonly (string | null)[]): string {
  let highest = -1
  let width = MIN_WIDTH

  for (const ref of refs) {
    if (!ref) continue
    const value = Number.parseInt(ref, 10)
    if (!Number.isFinite(value)) continue
    highest = Math.max(highest, value)
    width = Math.max(width, ref.length)
  }

  return String(highest + 1).padStart(width, '0')
}

/** `Terminal aesthetics!` → `terminal-aesthetics`. */
export function slug(title: string): string {
  const kebab = title
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks so "Café" becomes "cafe", not "caf".
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return kebab === '' ? 'untitled' : kebab
}

/** `notes/003-terminal-aesthetics.md` for ref 003. */
export function notePath(ref: string, title: string): string {
  return `notes/${ref}-${slug(title)}.md`
}

/**
 * A conforming new note (§04: "Creating a note").
 *
 * Written here rather than assembled in the store so the one place that decides
 * what a note looks like on disk is the one place that knows §04's contract.
 */
export function newNote(options: {
  ref: string
  title: string
  now: Date
  id?: string
}): string {
  const { ref, title, now } = options
  const created = now.toISOString().slice(0, 10)
  const modified = `${now.toISOString().slice(0, 19)}Z`

  return [
    '---',
    `id: ${options.id ?? ulid(now.getTime())}`,
    `ref: ${ref}`,
    `title: ${title}`,
    `created: ${created}`,
    `modified: ${modified}`,
    'tags: []',
    '---',
    '',
  ].join('\n')
}

/** The tags a note declares, for callers that only hold its text. */
export function tagsOf(source: string): string[] {
  return list(fields(source).get('tags'))
}
