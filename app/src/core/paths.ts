/**
 * §04's layout, as predicates.
 *
 * Deliberately importing nothing. The editor reaches these through `links.ts`,
 * and anything heavier here would be pulled across the lazy-chunk boundary with
 * it — which is how P6 accidentally loaded all of CodeMirror at boot.
 *
 * A vault holds three kinds of file and the difference matters at every surface:
 *
 * - **Notes.** What you accumulate. Listed, searched, counted.
 * - **Furniture.** `CLAUDE.md` is the agent's brief and `templates/` are
 *   stencils. Real files you edit deliberately, but not knowledge — so listing
 *   them among your notes buries the notes, and counting a stencil's tags
 *   reports a tag no note of yours carries.
 * - **Artefacts.** `*.conflict-<ts>.md`, waiting to be merged. §04 wants them
 *   gone, not derived from — but they stay in the index, because that is the
 *   only place you would ever find one.
 */

/** The agent contract §04 puts at the vault root. */
export const CONTRACT = 'CLAUDE.md'
/** §04's stencil folder; `GO · DAILY LOG` cuts today's note from this one. */
export const DAILY_TEMPLATE = 'templates/daily.md'

export function isContract(path: string): boolean {
  return path === CONTRACT
}

/** Whether a path is a stencil rather than a note (§04 layout: `templates/`). */
export function isTemplate(path: string): boolean {
  return path === 'templates' || path.startsWith('templates/')
}

/**
 * Whether a path is an unresolved conflict copy (§04: `*.conflict-<ts>.md`).
 *
 * A copy carries the original's ref, title and tags verbatim, so counting it
 * would double every tag and resolving `[[…]]` to it would shadow the note it
 * was copied from.
 */
export function isConflictCopy(path: string): boolean {
  return path.includes('.conflict-')
}

/**
 * Whether the INDEX lists it.
 *
 * Furniture is out. Both kinds stay reachable — ⌘K searches every note-shaped
 * file in the vault, and a stencil is also a row under NEW FROM TEMPLATE — so
 * this hides them from a list, not from the app.
 */
export function isListed(path: string): boolean {
  return !isContract(path) && !isTemplate(path)
}

/**
 * Whether backlinks, tags and tasks count it.
 *
 * Stricter than `isListed`: an artefact is listed so you can find it, and
 * derived from by nothing, because every one of its lines already belongs to
 * the note it was copied from.
 */
export function isDerived(path: string): boolean {
  return isListed(path) && !isConflictCopy(path)
}
