import { resolveSrc } from './paths'

/**
 * What a move has to rewrite, and in which notes (§04 Rev Y).
 *
 * The feature carried the framing "does the app rewrite your prose" for months,
 * and that overstated it — measurably. `[[wikilinks]]` resolve by **ref or
 * title**, never by path, so moving a note or a whole folder breaks none of
 * them. Only `![alt](src)` and `[text](src)` are relative, and only relative to
 * the note holding them.
 *
 * So the real scope is narrow and this file is the whole of it: when a note
 * moves away from a file it points at, the reference has to be re-pointed at the
 * file it already meant. Moving a folder usually rewrites *nothing*, because the
 * images travel with the notes.
 */

/** One reference that will stop resolving, and what it should say instead. */
export interface Rewrite {
  /** The note holding the reference — its path *after* the move. */
  note: string
  /** Exactly as written in the source, so the replacement is unambiguous. */
  was: string
  /** What it must become for the vault path to stay the same. */
  now: string
}

/** `![alt](src)` and `[text](src)`, with the target captured. */
const REFERENCE = /(!?\[[^\]]*\]\()([^)\s]+)(\))/g

/**
 * Where `path` ends up when `from` moves to `to`.
 *
 * Handles the folder case: `notes/apollo` → `archive/apollo` moves
 * `notes/apollo/010.md` to `archive/apollo/010.md`. Returns null for a path the
 * move does not touch.
 */
export function moved(path: string, from: string, to: string): string | null {
  if (path === from) return to
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`
  return null
}

/**
 * Every reference that has to change, given the corpus as it stands.
 *
 * Two directions, and both are needed:
 *
 *  - a note **inside** the move whose target stayed behind, and
 *  - a note **outside** it pointing at a target that went.
 *
 * A reference is only rewritten when its resolved vault path is unchanged by the
 * move and its *text* would now resolve somewhere else — or the reverse. What is
 * never touched is a reference that still means the same file, which is why
 * moving a folder whole rewrites nothing at all.
 */
export function rewrites(
  corpus: Record<string, { body: string }>,
  from: string,
  to: string,
): Rewrite[] {
  const out: Rewrite[] = []

  for (const [notePath, held] of Object.entries(corpus)) {
    const noteAfter = moved(notePath, from, to) ?? notePath
    for (const match of held.body.matchAll(REFERENCE)) {
      const src = match[2]
      if (src === undefined) continue
      const target = resolveSrc(notePath, src)
      // Absolute URLs, mailto:, anything that never was a vault path.
      if (target === null) continue

      // Where that file is once the move has happened.
      const targetAfter = moved(target, from, to) ?? target
      // What the reference would resolve to, unchanged, from the note's new home.
      const wouldMean = resolveSrc(noteAfter, src)
      if (wouldMean === targetAfter) continue

      const now = relative(noteAfter, targetAfter)
      if (now === null || now === src) continue
      out.push({ note: noteAfter, was: src, now })
    }
  }

  return out
}

/** Apply the rewrites for one note to its body. */
export function apply(body: string, changes: Rewrite[]): string {
  if (changes.length === 0) return body
  return body.replace(REFERENCE, (whole, open: string, src: string, close: string) => {
    const change = changes.find((one) => one.was === src)
    return change === undefined ? whole : `${open}${change.now}${close}`
  })
}

/**
 * `target` written relative to the folder holding `note`.
 *
 * Kept relative rather than rewritten to a vault-absolute `/path`: §12 requires
 * markdown stay the literal source, and turning every moved reference into a
 * form the writer did not use is the app editing prose in a way they would
 * notice. `../` is what a person would have typed.
 */
function relative(note: string, target: string): string | null {
  const fromParts = note.split('/').slice(0, -1)
  const toParts = target.split('/')
  const file = toParts.pop()
  if (file === undefined) return null

  let shared = 0
  while (
    shared < fromParts.length &&
    shared < toParts.length &&
    fromParts[shared] === toParts[shared]
  ) {
    shared += 1
  }

  const up = Array.from({ length: fromParts.length - shared }, () => '..')
  const down = toParts.slice(shared)
  const path = [...up, ...down, file].join('/')
  return path === '' ? null : path
}
