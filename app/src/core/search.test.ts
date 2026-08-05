import { describe, expect, it } from 'vitest'
import type { Entry, Loaded } from './api'
import { highlight, SearchIndex, snippet } from './search'

function note(options: {
  ref: string
  title: string
  body: string
  tags?: string[]
  mtime?: number
  etag?: string
}): { entry: Entry; body: string } {
  const path = `notes/${options.ref}-${options.title.toLowerCase().replace(/\W+/g, '-')}.md`
  return {
    entry: {
      path,
      ref: options.ref,
      title: options.title,
      tags: options.tags ?? [],
      mtime: options.mtime ?? 0,
      size: options.body.length,
      etag: options.etag ?? 'v1',
    },
    body: options.body,
  }
}

function vault(notes: { entry: Entry; body: string }[]) {
  const corpus: Record<string, Loaded> = {}
  for (const { entry, body } of notes) corpus[entry.path] = { body, etag: entry.etag }
  return { notes: notes.map((n) => n.entry), corpus }
}

const FRONT = [
  '---',
  'id: 01J2ZK7Q8W3E5R9T',
  'modified: 2026-08-05T10:00:00Z',
  '---',
].join('\n')

const SAMPLE = [
  note({
    ref: '003',
    title: 'Terminal aesthetics',
    tags: ['design'],
    mtime: 300,
    body: `${FRONT}\nOne typeface. Two weights. It should read like a spec, not a poster.`,
  }),
  note({
    ref: '004',
    title: 'Perf doctrine',
    tags: ['perf', 'design'],
    mtime: 400,
    body: `${FRONT}\nSixteen milliseconds. Keep it there — latency is the product.`,
  }),
  note({
    ref: '005',
    title: 'Inbox',
    mtime: 500,
    body: `${FRONT}\nCapture queue. See [[Terminal aesthetics]] before rewriting anything.`,
  }),
]

function indexed() {
  const index = new SearchIndex()
  const { notes, corpus } = vault(SAMPLE)
  index.sync(notes, corpus)
  return index
}

describe('SearchIndex', () => {
  it('searches bodies, not only the titles the tree already carries', () => {
    // §02b: "⌘K must run real full-text search over the corpus, not filter a
    // fixed command list."
    expect(
      indexed()
        .find('poster', 10)
        .map((hit) => hit.entry.ref),
    ).toEqual(['003'])
  })

  it('matches a prefix as it is typed, best first', () => {
    const hits = indexed().find('termi', 10)
    expect(hits.map((hit) => hit.entry.ref)).toEqual(['003', '005'])
    // The title match outranks the body mention.
    expect(hits[0]?.terms).toEqual(['terminal'])
  })

  it('finds a note by its ref, and only that note', () => {
    // A ref is §04's addressing scheme. Fuzzy matching would put every other
    // three-digit ref one edit away and return the whole vault.
    expect(
      indexed()
        .find('003', 10)
        .map((hit) => hit.entry.ref),
    ).toEqual(['003'])
  })

  it('finds a note by a tag it declares', () => {
    expect(
      indexed()
        .find('perf', 10)
        .map((hit) => hit.entry.ref),
    ).toEqual(['004'])
  })

  it('tolerates a typo in a real word', () => {
    expect(
      indexed()
        .find('milliseconds', 10)
        .map((hit) => hit.entry.ref),
    ).toEqual(['004'])
    expect(
      indexed()
        .find('millisecnds', 10)
        .map((hit) => hit.entry.ref),
    ).toEqual(['004'])
  })

  it('narrows as words are added rather than widening', () => {
    expect(indexed().find('typeface', 10)).toHaveLength(1)
    expect(indexed().find('typeface milliseconds', 10)).toHaveLength(0)
  })

  it('never indexes frontmatter', () => {
    // Every note carries `modified` and an id. If they were indexed, one of them
    // would match every note in the vault and the snippet would be YAML.
    expect(indexed().find('modified', 10)).toEqual([])
    expect(indexed().find('01J2ZK7Q8W3E5R9T', 10)).toEqual([])
  })

  it('answers an empty query with the most recently touched notes', () => {
    // The palette opens on an empty query, and the useful answer there is not
    // "nothing".
    expect(
      indexed()
        .find('', 2)
        .map((hit) => hit.entry.ref),
    ).toEqual(['005', '004'])
  })

  it('honours the limit it is given', () => {
    expect(indexed().find('the', 1)).toHaveLength(1)
  })

  it('leaves conflict copies out, as every other derivation does', () => {
    const copy = note({
      ref: '003',
      title: 'Terminal aesthetics',
      body: `${FRONT}\nOne typeface. Two weights.`,
      etag: 'c1',
    })
    copy.entry.path = 'notes/003-terminal.conflict-20260805T101500000Z.md'

    const index = new SearchIndex()
    const { notes, corpus } = vault([...SAMPLE, copy])
    index.sync(notes, corpus)
    expect(index.find('typeface', 10).map((hit) => hit.entry.path)).toEqual([
      SAMPLE[0]?.entry.path,
    ])
  })

  it('indexes only what changed, and nothing at all when nothing did', () => {
    const index = new SearchIndex()
    const { notes, corpus } = vault(SAMPLE)

    expect(index.sync(notes, corpus)).toBe(3)
    expect(index.sync(notes, corpus)).toBe(0)

    const path = SAMPLE[1]?.entry.path ?? ''
    corpus[path] = { body: `${FRONT}\nRewritten: hairlines are chrome.`, etag: 'v2' }
    expect(index.sync(notes, corpus)).toBe(1)
    expect(index.find('hairlines', 10).map((hit) => hit.entry.ref)).toEqual(['004'])
    // The old text is gone, not shadowed.
    expect(index.find('milliseconds', 10)).toEqual([])
  })

  it('forgets a note that left the vault', () => {
    const index = new SearchIndex()
    const { notes, corpus } = vault(SAMPLE)
    index.sync(notes, corpus)

    const left = notes.filter((entry) => entry.ref !== '003')
    index.sync(left, corpus)
    expect(index.find('typeface', 10)).toEqual([])
    expect(index.find('', 10).map((hit) => hit.entry.ref)).toEqual(['005', '004'])
  })

  it('waits for a body rather than indexing a note empty', () => {
    const index = new SearchIndex()
    const { notes, corpus } = vault(SAMPLE)
    expect(index.sync(notes, {})).toBe(0)
    expect(index.sync(notes, corpus)).toBe(3)
  })
})

describe('a 1k-note vault (§08 P6: searches under 20 ms)', () => {
  const WORDS = [
    'hairline',
    'typeface',
    'latency',
    'vault',
    'register',
    'inverse',
    'doctrine',
    'budget',
    'monospace',
    'plaintext',
  ]

  const many = Array.from({ length: 1000 }, (_, n) => {
    const ref = String(n).padStart(3, '0')
    // Deterministic filler, so the measurement is of the same corpus every run.
    const body = Array.from(
      { length: 60 },
      (_, w) => `${WORDS[(n + w) % WORDS.length]} note ${n} paragraph ${w}`,
    ).join(' ')
    return note({
      ref,
      title: `Note ${ref} ${WORDS[n % WORDS.length]}`,
      tags: [WORDS[(n + 3) % WORDS.length] ?? 'tag'],
      mtime: n,
      body: `${FRONT}\n${body}`,
    })
  })

  const index = new SearchIndex()
  const { notes, corpus } = vault(many)
  index.sync(notes, corpus)

  it('holds the whole vault', () => {
    expect(index.find('', 5000)).toHaveLength(1000)
  })

  it('answers every query in well under 20 ms', () => {
    const queries = ['hairline', 'typ', 'latency budget', '742', 'monospace', 'doctrne']
    // One untimed pass: the first search allocates, and a budget measured on a
    // cold call measures the allocator, not the index.
    for (const query of queries) index.find(query, 20)

    let worst = 0
    for (const query of queries) {
      const started = performance.now()
      const hits = index.find(query, 20)
      worst = Math.max(worst, performance.now() - started)
      expect(hits.length).toBeGreaterThan(0)
    }
    expect(worst).toBeLessThan(20)
  })

  it('costs one document to fold in a single edit', () => {
    const path = many[500]?.entry.path ?? ''
    corpus[path] = { body: `${FRONT}\nrewritten with pantograph`, etag: 'v2' }

    const started = performance.now()
    expect(index.sync(notes, corpus)).toBe(1)
    // The re-index is one document; the diff that finds it walks the tree. Both
    // together have to stay inside §06's 16 ms interaction budget.
    expect(performance.now() - started).toBeLessThan(16)
    expect(index.find('pantograph', 10)).toHaveLength(1)
  })
})

describe('highlight', () => {
  it('marks whole matched terms, case-insensitively', () => {
    expect(highlight('Terminal aesthetics', ['terminal'])).toEqual([
      { text: 'Terminal', hit: true },
      { text: ' aesthetics', hit: false },
    ])
  })

  it('marks every occurrence of every term', () => {
    expect(highlight('one two one', ['one', 'two'])).toEqual([
      { text: 'one', hit: true },
      { text: ' ', hit: false },
      { text: 'two', hit: true },
      { text: ' ', hit: false },
      { text: 'one', hit: true },
    ])
  })

  it('leaves the text whole when nothing matched', () => {
    expect(highlight('Terminal', [])).toEqual([{ text: 'Terminal', hit: false }])
  })

  it('treats a term as text, not as a pattern', () => {
    // Terms come from the document. `a.c` must not match `abc`.
    expect(highlight('abc a.c', ['a.c'])).toEqual([
      { text: 'abc ', hit: false },
      { text: 'a.c', hit: true },
    ])
  })
})

describe('snippet', () => {
  const body = `${FRONT}\nOne typeface. Two weights. It should read like a spec, not a poster.`

  it('excerpts around the match, never out of the frontmatter', () => {
    const found = snippet(body, ['spec'])
    expect(found).toContain('spec')
    expect(found).not.toContain('id:')
  })

  it('says nothing when nothing matched', () => {
    expect(snippet(body, ['absent'])).toBe('')
    expect(snippet(body, [])).toBe('')
  })

  it('marks both cuts with an ellipsis and stays inside its width', () => {
    const long = `${FRONT}\n${'filler word '.repeat(40)}needle${' more words'.repeat(40)}`
    const found = snippet(long, ['needle'], 40)
    expect(found).toContain('needle')
    expect(found.startsWith('…')).toBe(true)
    expect(found.endsWith('…')).toBe(true)
    expect(found.length).toBeLessThanOrEqual(42)
  })

  it('collapses the newlines a note is written with', () => {
    expect(snippet(`${FRONT}\nfirst line\nsecond line\nthird`, ['second'])).toBe(
      'first line second line third',
    )
  })
})
