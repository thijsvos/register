/**
 * Tag counts across the vault, for the sidebar meters and the inspector.
 *
 * §04 declares tags in frontmatter, so `/api/tree` has already parsed them and
 * this counts rather than re-reads. Nothing is stored: the meters are a view of
 * the tree, and they change when the files do.
 */
import type { Entry } from './api'
import { derived } from './links'

export interface TagCount {
  name: string
  /** How many notes carry it. */
  count: number
}

/**
 * Every tag in the vault, commonest first, ties broken alphabetically so the
 * order is stable across refreshes rather than dependent on scan order.
 */
export function tagCounts(notes: Entry[]): TagCount[] {
  const counts = new Map<string, number>()

  for (const entry of derived(notes)) {
    // A note that lists the same tag twice carries it once.
    for (const tag of new Set(entry.tags)) {
      const name = tag.trim()
      if (name === '') continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }

  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** How many notes carry each of `tags`, in the order the note declares them. */
export function countsFor(notes: Entry[], tags: string[]): TagCount[] {
  const all = new Map(tagCounts(notes).map((tag) => [tag.name, tag.count]))
  return tags.map((name) => ({ name, count: all.get(name) ?? 0 }))
}
