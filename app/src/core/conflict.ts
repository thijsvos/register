/**
 * Unresolved conflicts, derived from the tree (§02b Screen 4).
 *
 * Nothing here is stored. A conflict *is* a pair of files, so the list of them
 * is a read of `/api/tree` and nothing else — which is the point: the store's
 * transient `notice` is lost by the next save, and one branch of the 409 path
 * never sets it at all, but a file on disk cannot go unannounced.
 */
import type { Entry } from './api'
import { isConflictCopy } from './paths'

export interface Conflict {
  /** The `*.conflict-<ts>.md` copy, holding what you had typed. */
  copy: Entry
  /** Where it was copied from — a path, whether or not the note still exists. */
  from: string
  /** That note, or null when it has since been removed. */
  original: Entry | null
}

/**
 * The note a conflict copy was parked beside, or null if `path` is not one.
 *
 * The inverse of the store's `#park`, which appends `.conflict-<stamp>` — and
 * `-<n>` after it when two conflicts land inside the same millisecond — between
 * the note's name and its extension. Anchored to the last segment so a folder
 * that happens to contain `.conflict-` cannot be mistaken for a copy.
 */
export function originalOf(path: string): string | null {
  const original = path.replace(/\.conflict-[^/]*\.md$/, '.md')
  return original === path ? null : original
}

/**
 * Every unresolved conflict in the vault, newest first.
 *
 * Newest first because the one you want is almost always the one that just
 * happened; the rest are older business you can take in any order.
 */
export function conflicts(tree: readonly Entry[]): Conflict[] {
  const byPath = new Map(tree.map((entry) => [entry.path, entry]))

  return tree
    .filter((entry) => isConflictCopy(entry.path))
    .flatMap((copy) => {
      const from = originalOf(copy.path)
      // `isConflictCopy` matches anywhere in the path and this does not, so a
      // copy it cannot name is left out rather than paired with a guess.
      return from === null ? [] : [{ copy, from, original: byPath.get(from) ?? null }]
    })
    .sort((one, other) => other.copy.mtime - one.copy.mtime)
}
