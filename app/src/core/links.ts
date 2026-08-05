/**
 * The link graph: `[[wikilinks]]` parsed out of the corpus and inverted.
 *
 * §04 keeps the whole graph derived — "links, tasks, tags, search are all
 * client-side derivations of plain text" — so nothing here is ever stored. It is
 * recomputed from the bodies the store already holds, incrementally, because the
 * inspector reads it on every note switch and a full re-parse of a 1k-note vault
 * does not fit in §06's 16 ms interaction budget.
 */
import type { Entry, Loaded } from './api'
import { isDerived } from './paths'

/**
 * `[[Title]]` or `[[003]]`, with an optional `|alias` the vault ignores.
 *
 * Global, so it must only ever be used with `matchAll`, which works on its own
 * copy. A shared `g` regex driven by `test` or `exec` carries `lastIndex`
 * between callers and starts the next scan halfway down an unrelated note.
 */
export const WIKILINK = /\[\[([^\][\n|]+)(?:\|[^\][\n]*)?\]\]/g

/** The notes a `[[…]]` may resolve to, and the notes derivations count from. */
export function derived(notes: Entry[]): Entry[] {
  return notes.filter((entry) => isDerived(entry.path))
}

/**
 * Every distinct `[[…]]` target in a note, in document order.
 *
 * Matched over the raw text, frontmatter and fenced code included, because the
 * editor's decoration builder does the same: it works from the viewport, so it
 * cannot know whether a fence opened above the visible range. Teaching this one
 * about fences would produce links the editor underlines and offers to follow
 * but that never appear in any backlink list — a disagreement between two views
 * of the same file is worse than either rule alone.
 */
export function linkTargets(source: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of source.matchAll(WIKILINK)) {
    const target = (match[1] ?? '').trim()
    if (target === '') continue
    const key = target.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(target)
  }
  return out
}

/**
 * Resolve `[[…]]` targets by ref or title in constant time.
 *
 * Built once per tree rather than scanned per link: the editor asks `exists()`
 * for every visible link on every keystroke, and the graph asks once per link in
 * the vault — a linear scan in either place is quadratic across the corpus.
 */
export class NoteLookup {
  readonly #byRef = new Map<string, Entry>()
  readonly #byTitle = new Map<string, Entry>()

  constructor(notes: Entry[]) {
    for (const entry of derived(notes)) {
      // First wins, so a lookup answers by the order `/api/tree` lists notes in
      // rather than by whichever duplicate happened to be scanned last.
      if (entry.ref !== null && !this.#byRef.has(entry.ref)) {
        this.#byRef.set(entry.ref, entry)
      }
      const title = (entry.title ?? '').trim().toLowerCase()
      if (title !== '' && !this.#byTitle.has(title)) this.#byTitle.set(title, entry)
    }
  }

  /** Ref first: a ref is immutable and unique, a title is neither (§04). */
  find(target: string): Entry | null {
    const wanted = target.trim()
    return this.#byRef.get(wanted) ?? this.#byTitle.get(wanted.toLowerCase()) ?? null
  }
}

/**
 * Who links to whom, kept in step with the corpus.
 *
 * Parsing is cached per note and keyed by etag, so a save re-parses one body and
 * a watcher burst re-parses only what actually changed. The inversion itself is
 * rebuilt whole, which is proportional to the number of links rather than to the
 * size of the vault.
 */
export class LinkGraph {
  /** Targets per note, and the etag they were parsed from. */
  readonly #parsed = new Map<string, { etag: string; targets: string[] }>()
  /** Target path → the notes linking to it, in tree order. */
  #back = new Map<string, Entry[]>()
  /** The tree the inversion was built from, to skip rebuilding for the same one. */
  #built: Entry[] | null = null

  /**
   * Fold the current tree and corpus in. Returns how many bodies it had to
   * parse — zero on a no-op, which is what makes this safe to call from a
   * `$derived` on every read.
   */
  sync(notes: Entry[], corpus: Record<string, Loaded>): number {
    let parsed = 0
    const live = new Set<string>()

    for (const entry of notes) {
      live.add(entry.path)
      const held = corpus[entry.path]
      // A body that has not arrived yet is not an absence of links; it is simply
      // unknown, and the fill will bring it with a new etag.
      if (held === undefined) continue
      if (this.#parsed.get(entry.path)?.etag === held.etag) continue
      this.#parsed.set(entry.path, {
        etag: held.etag,
        targets: linkTargets(held.body),
      })
      parsed++
    }

    let dropped = 0
    for (const path of [...this.#parsed.keys()]) {
      if (live.has(path)) continue
      this.#parsed.delete(path)
      dropped++
    }

    // The tree is replaced wholesale by every refresh, so identity is the test:
    // a title can change without any body this graph holds changing, and that
    // still re-points every link that named it.
    if (parsed === 0 && dropped === 0 && this.#built === notes) return 0
    this.#built = notes
    this.#invert(notes)
    return parsed
  }

  /** The notes linking to `path`, in tree order. Never includes `path` itself. */
  backlinks(path: string): Entry[] {
    return this.#back.get(path) ?? []
  }

  #invert(notes: Entry[]): void {
    const lookup = new NoteLookup(notes)
    const back = new Map<string, Entry[]>()

    for (const entry of derived(notes)) {
      const parsed = this.#parsed.get(entry.path)
      if (parsed === undefined) continue
      // Distinct targets can name one note: `[[003]]` and `[[Terminal
      // aesthetics]]` are the same link written two ways, and a pane that
      // counted both would report two backlinks from one note.
      const linked = new Set<string>()
      for (const target of parsed.targets) {
        const found = lookup.find(target)
        // A note linking to itself is not a backlink; it is a note mentioning
        // its own name, and listing it would put every note in its own pane.
        if (found === null || found.path === entry.path) continue
        if (linked.has(found.path)) continue
        linked.add(found.path)
        const linkers = back.get(found.path)
        if (linkers === undefined) back.set(found.path, [entry])
        else linkers.push(entry)
      }
    }

    this.#back = back
  }
}

/** The vault's one graph. Warm from boot so no pane pays to build it. */
export const links = new LinkGraph()
