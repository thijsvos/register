/**
 * Full-text search over the loaded corpus (§04: MiniSearch, client-side).
 *
 * §02b is explicit that ⌘K "must run real full-text search over the corpus, not
 * filter a fixed command list", so this indexes bodies, not just the titles the
 * tree already carries. It stays in memory and is never written anywhere: the
 * index is a derivation of the files, and a stale one is a bug the next sync
 * fixes rather than a file someone has to clean up.
 */
import MiniSearch, { type SearchOptions } from 'minisearch'
import type { Entry, Loaded } from './api'
import { split } from './frontmatter'
import { isConflictCopy } from './paths'

/** One row of the ⌘K note list. */
export interface Hit {
  entry: Entry
  /** The indexed terms that matched, for highlighting. `termi` yields `terminal`. */
  terms: string[]
}

/** A run of text, marked when it is part of a match (§02b: signal colour). */
export interface Segment {
  text: string
  hit: boolean
}

/** How much of a body a snippet may show before it is cut. */
const SNIPPET_WIDTH = 90
/** How far back a snippet may reach for a word boundary before giving up. */
const SNIPPET_ALIGN = 16

/**
 * `ref` is indexed alongside §02b's title/body/tags because a ref is how §04
 * addresses a note — `[[003]]` is a first-class link — and a palette that cannot
 * find `003` is missing the vault's own primary key.
 */
const FIELDS = ['title', 'ref', 'tags', 'body']

/** `tag:research`, with an optional `#` — what clicking a tag types. */
const TAG_QUERY = /^tag:#?([^\s]+)$/i

const SEARCH_OPTIONS: SearchOptions = {
  prefix: true,
  /**
   * No fuzziness on refs or short words. At a 0.2 ratio a three-character term
   * tolerates one edit, so typing `003` also matches `004` and `005` — every ref
   * in the vault is one edit from every other, and §04's addressing scheme would
   * return the whole corpus. Longer words keep it: `sixten` should still find
   * "sixteen".
   */
  fuzzy: (term: string) => (term.length >= 5 && !/\d/.test(term) ? 0.2 : false),
  /** A title match is worth more than a body match; a ref match is exact intent. */
  boost: { title: 4, ref: 8, tags: 2 },
  /** Every word must match: a palette narrows as you type, it does not widen. */
  combineWith: 'AND',
}

interface Document {
  path: string
  title: string
  ref: string
  tags: string
  body: string
}

export class SearchIndex {
  readonly #mini = fresh()
  /** Indexed notes and the etag each was indexed from. */
  readonly #indexed = new Map<string, string>()
  /** The tree rows behind the index, so a hit can be rendered without a lookup. */
  readonly #entries = new Map<string, Entry>()

  /**
   * Fold the current tree and corpus in. Returns how many documents it had to
   * index — zero on a no-op.
   *
   * Incremental because the alternative is not affordable: building the index
   * over a 1k-note vault costs far more than §06 allows the palette to take to
   * open, so it is kept warm from boot and each arriving body costs one add.
   */
  sync(notes: Entry[], corpus: Record<string, Loaded>): number {
    let indexed = 0
    const live = new Set<string>()

    for (const entry of notes) {
      if (isConflictCopy(entry.path)) continue
      const held = corpus[entry.path]
      // Bodies arrive behind the tree. A note without one yet is indexed when it
      // lands, rather than indexed empty and left that way.
      if (held === undefined) continue
      live.add(entry.path)
      this.#entries.set(entry.path, entry)
      if (this.#indexed.get(entry.path) === held.etag) continue

      const document = toDocument(entry, held.body)
      if (this.#indexed.has(entry.path)) this.#mini.replace(document)
      else this.#mini.add(document)
      this.#indexed.set(entry.path, held.etag)
      indexed++
    }

    for (const path of [...this.#indexed.keys()]) {
      if (live.has(path)) continue
      this.#mini.discard(path)
      this.#indexed.delete(path)
      this.#entries.delete(path)
    }

    return indexed
  }

  /**
   * Notes matching `query`, best first.
   *
   * An empty query is not an empty result: the palette opens on it, and the
   * useful answer there is what was touched most recently.
   */
  find(query: string, limit: number): Hit[] {
    const wanted = query.trim()

    // `tag:name` is an exact filter rather than a search, and it exists because
    // clicking a tag has to mean what it says. Free text would find every note
    // *mentioning* the word too, boosted or not, which turns "show me what is
    // tagged research" into "show me research" — a different question with a
    // longer answer. Tags are an exact set on every entry, so this reads them
    // rather than the index.
    const tag = TAG_QUERY.exec(wanted)
    if (tag !== null) {
      const wantedTag = (tag[1] ?? '').toLowerCase()
      return [...this.#entries.values()]
        .filter((entry) => entry.tags.some((one) => one.toLowerCase() === wantedTag))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit)
        .map((entry) => ({ entry, terms: [] }))
    }

    if (wanted === '') {
      return [...this.#entries.values()]
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit)
        .map((entry) => ({ entry, terms: [] }))
    }

    const hits: Hit[] = []
    for (const result of this.#mini.search(wanted, SEARCH_OPTIONS)) {
      const entry = this.#entries.get(String(result.id))
      // A note discarded between the search and this loop is simply gone.
      if (entry === undefined) continue
      hits.push({ entry, terms: result.terms })
      if (hits.length === limit) break
    }
    return hits
  }
}

function fresh(): MiniSearch<Document> {
  return new MiniSearch<Document>({
    idField: 'path',
    fields: FIELDS,
    searchOptions: SEARCH_OPTIONS,
  })
}

function toDocument(entry: Entry, source: string): Document {
  return {
    path: entry.path,
    title: entry.title ?? '',
    ref: entry.ref ?? '',
    tags: entry.tags.join(' '),
    // Frontmatter is metadata, not prose: indexing it would make every note a
    // hit for "modified", and put a line of YAML in the snippet.
    body: split(source).body,
  }
}

/** Escape a term for use inside a RegExp. Terms come from text, not from code. */
function quote(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pattern(terms: string[]): RegExp | null {
  const usable = terms.filter((term) => term !== '').map(quote)
  if (usable.length === 0) return null
  return new RegExp(usable.join('|'), 'gi')
}

/**
 * Split `text` so the matched runs can carry the signal colour (§02b Screen 2).
 *
 * Whole terms, not the subsequence the command list uses: these came back from
 * the index, so they are the words actually in the document.
 */
export function highlight(text: string, terms: string[]): Segment[] {
  const matcher = pattern(terms)
  if (matcher === null || text === '') return [{ text, hit: false }]

  const out: Segment[] = []
  let at = 0
  for (const match of text.matchAll(matcher)) {
    const start = match.index ?? 0
    if (start > at) out.push({ text: text.slice(at, start), hit: false })
    out.push({ text: match[0], hit: true })
    at = start + match[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false })
  return out
}

/**
 * A one-line excerpt of the body around the first match (§02b: "…read like a
 * spec…").
 *
 * Empty when nothing matches, so the caller can show something else rather than
 * the opening words of every note in the vault.
 */
export function snippet(source: string, terms: string[], width = SNIPPET_WIDTH): string {
  const body = split(source).body.replace(/\s+/g, ' ').trim()
  const matcher = pattern(terms)
  if (matcher === null || body === '') return ''

  const found = matcher.exec(body)
  if (found === null) return ''

  // Centred on the match, then pulled back to a word boundary so the excerpt
  // does not open mid-word. The lookback is bounded: an unbroken run longer than
  // that would drag the window back far enough to push the match out of it.
  const start = Math.max(0, found.index - Math.floor((width - found[0].length) / 2))
  const back = body.lastIndexOf(' ', start)
  const head = start > 0 && back >= start - SNIPPET_ALIGN && back >= 0 ? back + 1 : start
  const cut = body.slice(head, head + width)
  const tail = head + width < body.length ? `${cut.trimEnd()}…` : cut
  return head > 0 ? `…${tail}` : tail
}

/** The vault's one index. Warm from boot so the palette never builds it. */
export const search = new SearchIndex()
