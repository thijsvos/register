import { ulid } from '../lib/ulid'
import { fields, list } from './frontmatter'

// Ref allocation lives on the server, not here. Only the server can see
// `.register/trash/`, so only the server knows which refs have ever been handed
// out — and §04 now requires that a ref, once allocated, is never reissued.
// `/api/tree` reports it as `nextRef`.

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
