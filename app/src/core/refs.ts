import { ulid } from '../lib/ulid'
import { fields, list, setField, split } from './frontmatter'

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

/** Where a note goes when nobody says otherwise — §04's layout. */
export const DEFAULT_FOLDER = 'notes'

/**
 * `notes/003-terminal-aesthetics.md` for ref 003, or the same under any folder.
 *
 * The ref is unaffected by the folder: `next_ref` walks the whole vault, so a
 * note three levels down still takes the next number in the register. Nesting
 * changes where a note lives, never what it is called.
 */
export function notePath(ref: string, title: string, folder = DEFAULT_FOLDER): string {
  return `${folder}/${ref}-${slug(title)}.md`
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

  return [
    '---',
    `id: ${options.id ?? ulid(now.getTime())}`,
    `ref: ${ref}`,
    `title: ${title}`,
    `created: ${day(now)}`,
    `modified: ${isoSeconds(now)}`,
    'tags: []',
    '---',
    '',
  ].join('\n')
}

/** `daily/2026-08-05.md` — §04's dated-log shape. */
export function dailyPath(now: Date): string {
  return `daily/${now.toISOString().slice(0, 10)}.md`
}

/**
 * A conforming daily log.
 *
 * No `ref`: §04 gives daily logs their own filename shape, and a date is not a
 * ref — the server's allocator skips `daily/` for exactly that reason. P7 adds
 * creation from `templates/daily.md`; this is the bare conforming note.
 */
export function newDaily(now: Date, id?: string): string {
  return [
    '---',
    `id: ${id ?? ulid(now.getTime())}`,
    `title: ${day(now)}`,
    `created: ${day(now)}`,
    `modified: ${isoSeconds(now)}`,
    'tags: [daily]',
    '---',
    '',
  ].join('\n')
}

/** The tags a note declares, for callers that only hold its text. */
export function tagsOf(source: string): string[] {
  return list(fields(source).get('tags'))
}

/**
 * The per-note fields §04 requires, stamped into a template's frontmatter.
 *
 * Everything else the template author wrote — extra fields, key order,
 * comments, the body — is left byte for byte, because a template is someone's
 * decision about what a note of this kind looks like and the app has no opinion
 * beyond the five fields that must be right.
 */
function stamp(template: string, values: [string, string][]): string {
  let out = template
  for (const [key, value] of values) out = setField(out, key, value)
  return out
}

/** A conforming note built from `template`, or a bare one when there is none. */
export function noteFrom(
  template: string | null,
  options: { ref: string; title: string; now: Date; id?: string },
): string {
  const settled = { ...options, id: options.id ?? ulid(options.now.getTime()) }
  if (template === null) return newNote(settled)

  // A template with no frontmatter is a body, not a note. It gets a conforming
  // header rather than being written to disk as something §04 cannot read.
  const parts = split(template)
  if (parts.open === '') return newNote(settled) + parts.body

  const stamped = stamp(template, [
    ['id', settled.id],
    ['ref', settled.ref],
    ['title', settled.title],
    ['created', day(settled.now)],
    ['modified', isoSeconds(settled.now)],
  ])
  return fields(stamped).has('tags') ? stamped : setField(stamped, 'tags', '[]')
}

/** Today's daily log built from `template`, or a bare one when there is none. */
export function dailyFrom(template: string | null, now: Date, id?: string): string {
  const settled = id ?? ulid(now.getTime())
  if (template === null) return newDaily(now, settled)

  const parts = split(template)
  if (parts.open === '') return newDaily(now, settled) + parts.body

  // No ref: §04 gives daily logs their own filename shape, and a date is not a
  // ref — the server's allocator skips `daily/` for exactly that reason.
  const stamped = stamp(template, [
    ['id', settled],
    ['title', day(now)],
    ['created', day(now)],
    ['modified', isoSeconds(now)],
  ])
  return fields(stamped).has('tags') ? stamped : setField(stamped, 'tags', '[daily]')
}

function day(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function isoSeconds(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`
}
