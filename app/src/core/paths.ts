/**
 * §04's layout, as predicates.
 *
 * Deliberately importing nothing. The editor reaches these through `links.ts`,
 * and anything heavier here would be pulled across the lazy-chunk boundary with
 * it — which is how P6 accidentally loaded all of CodeMirror at boot.
 *
 * A vault holds four kinds of file and the difference matters at every surface:
 *
 * - **Notes.** What you accumulate. Listed, searched, counted.
 * - **Furniture.** `CLAUDE.md` is the agent's brief and `templates/` are
 *   stencils. Real files you edit deliberately, but not knowledge — so listing
 *   them among your notes buries the notes, and counting a stencil's tags
 *   reports a tag no note of yours carries.
 * - **Journal.** `daily/YYYY-MM-DD.md`. Knowledge, unlike furniture — its tasks
 *   belong in TODAY and its links in the graph — but there is one per day
 *   forever, and `daily/` sorts before `notes/`, so listing them put a growing
 *   wall of dated rows above every note you own. Seven after a week; three
 *   hundred and sixty-five after a year.
 * - **Artefacts.** `*.conflict-<ts>.md`, waiting to be merged. §04 wants them
 *   gone, not derived from — but they stay in the index, because that is the
 *   only place you would ever find one.
 *
 * Listed and derived are therefore **independent**. They used to be nested —
 * `isDerived` was `isListed && !isConflictCopy` — which could express "hidden
 * and uncounted" (furniture) and "shown and counted" (notes) but not the
 * journal's "hidden and counted". Untangling them is what makes the fix below
 * possible without emptying TODAY.
 */

/**
 * The last segment of a path.
 *
 * Here rather than in each caller because there were four copies of it — three
 * identical and one that also stripped `.md`, which is the point at which a
 * one-liner starts being a decision rather than an expression.
 */
export function basename(path: string): string {
  return path.split('/').pop() ?? path
}

/**
 * The directory segments of a path, outermost first.
 *
 * `notes/archive/018-old.md` → `['notes', 'archive']`. Not compacted the way the
 * INDEX tree compacts a single-child chain into one row: a crumb is the answer
 * to "where is this file", and eliding a real folder from it would make the
 * answer wrong to save a few characters.
 */
export function folders(path: string): string[] {
  return path
    .split('/')
    .slice(0, -1)
    .filter((segment) => segment !== '')
}

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

/** Whether a path is a daily log (§04 layout: `daily/YYYY-MM-DD.md`). */
export function isDaily(path: string): boolean {
  return path === 'daily' || path.startsWith('daily/')
}

/**
 * Whether the INDEX lists it.
 *
 * Furniture and the journal are out. Everything stays reachable — ⌘K searches
 * every note-shaped file in the vault, a stencil is also a row under NEW FROM
 * TEMPLATE, and today's log is `⌘D`'s TODAY and `G D` away — so this hides them
 * from one list, not from the app.
 *
 * The journal is the P8 argument a second time. That one closed with "a first
 * real vault made the answer obvious": stencils among your notes bury the notes.
 * A daily log buries them faster, because there is one per day forever and
 * `daily/` sorts before `notes/`, so a year of dated rows accumulates *above*
 * everything you wrote.
 */
export function isListed(path: string): boolean {
  return !isContract(path) && !isTemplate(path) && !isDaily(path)
}

/**
 * Whether backlinks, tags and tasks count it.
 *
 * Not "listed, minus artefacts" — the two are independent, and the journal is
 * why. A daily log is knowledge: its `- [ ]` belongs in TODAY and its `[[…]]`
 * in the graph, and it is hidden from the INDEX only because there are so many.
 * Written as `isListed(path) && …` this would empty TODAY of everything you
 * wrote in a daily log, which is most of what people put in one.
 *
 * An artefact is the mirror case — listed so you can find it, derived from by
 * nothing, because every line it holds already belongs to the note it copied.
 */
export function isDerived(path: string): boolean {
  return !isContract(path) && !isTemplate(path) && !isConflictCopy(path)
}
