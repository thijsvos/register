import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultEvent } from './api'
import { fields } from './frontmatter'
import { vault } from './store.svelte'

/**
 * A stand-in for the Rust server, speaking §04's API over stubbed globals.
 *
 * `fetch` and `WebSocket` are only globals, so the store can be driven exactly
 * as the browser drives it without a DOM, a network, or a new dependency. The
 * real binary is exercised separately; this pins the client's own logic — the
 * debounce, the 409 path, and what an external event does to an open buffer.
 */
class FakeVault {
  files = new Map<string, { body: string; etag: string }>()
  requests: string[] = []
  #version = 0
  #sockets: FakeSocket[] = []

  /** Every ref ever seen. Never forgotten, matching src/vault.rs::next_ref,
   *  which counts `.register/trash/` so a ref is issued at most once. */
  #everUsed = new Set<number>()

  /** Emulate a case-insensitive filesystem, which macOS and Windows are. */
  foldsCase = false

  /**
   * Served on GET, absent from the tree — an agent's write the tree has not
   * caught up with. The one state in which the on-disk checks matter at all.
   */
  #unlisted = new Set<string>()

  hideFromTree(path: string): void {
    this.#unlisted.add(path)
  }

  /**
   * Answer the next tree request with the vault as it is *now*.
   *
   * What a superseded refresh looks like from the store's side: it asked, and
   * what came back does not include the change it just made. In the real thing
   * the staleness comes from `refresh` abandoning its own result when the
   * watcher's refresh overtakes it; the observable effect is identical.
   */
  serveStaleTreeOnce(): void {
    this.#staleTree = [...this.files.keys()]
  }

  #staleTree: string[] | null = null

  /** Paths that answer with a status instead of their content. */
  #broken = new Map<string, number>()

  /** What §08 P12's git field reports, or null for a vault that is not a repo. */
  git: Record<string, unknown> | null = null

  seed(path: string, body: string): void {
    this.files.set(path, { body, etag: `etag-${++this.#version}` })
    this.#remember(path)
  }

  /** Make a read fail with something other than 404 — present but unreadable. */
  fail(path: string, status: number): void {
    this.#broken.set(path, status)
  }

  #remember(path: string): void {
    // daily/YYYY-MM-DD.md carries a date, not a ref — mirroring
    // src/vault.rs::ref_from_path, which skips daily/ for the same reason.
    if (path.startsWith('daily/')) return
    const found = /(?:^|\/)(\d+)-/.exec(path)?.[1]
    if (found !== undefined) this.#everUsed.add(Number(found))
  }

  #nextRef(): string {
    const highest = this.#everUsed.size === 0 ? -1 : Math.max(...this.#everUsed)
    return String(highest + 1).padStart(3, '0')
  }

  /** Push a frame as the watcher would. */
  emit(event: VaultEvent): void {
    for (const socket of this.#sockets) socket.receive(JSON.stringify(event))
  }

  install(): void {
    const self = this
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(self.#handle(String(input), init))) as typeof fetch

    globalThis.WebSocket = class extends FakeSocket {
      constructor(url: string | URL) {
        super(String(url))
        self.#sockets.push(this)
      }
    } as unknown as typeof WebSocket

    // openEvents reads `location` to build the socket URL, and there is no
    // `location` outside a browser.
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { protocol: 'http:', host: 'localhost:7777' },
    })
  }

  #handle(url: string, init?: RequestInit): Response {
    const method = init?.method ?? 'GET'
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    this.requests.push(`${method} ${path}`)

    if (path === '/api/tree') {
      const snapshot = this.#staleTree
      this.#staleTree = null
      const source =
        snapshot === null
          ? [...this.files.entries()]
          : snapshot.map(
              (p) =>
                [p, this.files.get(p) ?? { body: '', etag: 'stale' }] as [
                  string,
                  { body: string; etag: string },
                ],
            )
      const tree = source
        .filter(([notePath]) => !this.#unlisted.has(notePath))
        .map(([notePath, held]) => ({
          path: notePath,
          ref: /(?:^|\/)(\d+)-/.exec(notePath)?.[1] ?? null,
          title: fields(held.body).get('title') ?? null,
          tags: [],
          mtime: 0,
          size: held.body.length,
          etag: held.etag,
        }))
        .sort((a, b) => a.path.localeCompare(b.path))
      return json({
        vault: '/tmp/fake-vault',
        nextRef: this.#nextRef(),
        git: this.git,
        notes: tree,
      })
    }

    // §04 Rev P. The real one renames the directory whole, which is why the
    // counts it answers with are not derivable from the note list alone — the
    // media rides along and the client never saw it. Modelled here as a folder
    // holding one such file, so the notice has something to be wrong about.
    if (path.startsWith('/api/folder/')) {
      if (method !== 'DELETE') return new Response('no', { status: 405 })
      const folder = decodeURIComponent(path.replace('/api/folder/', ''))
      const held = [...this.files.keys()].filter((one) => one.startsWith(`${folder}/`))
      if (held.length === 0) return new Response('no such folder', { status: 404 })
      for (const one of held) this.files.delete(one)
      return json({ notes: held.length, files: 1, bucket: '.register/trash/1700' })
    }

    const notePath = decodeURIComponent(path.replace('/api/note/', ''))
    const held = this.files.get(notePath)

    if (method === 'GET') {
      const broken = this.#broken.get(notePath)
      if (broken !== undefined) return new Response('unreadable', { status: broken })
      return held
        ? new Response(held.body, { headers: { etag: `"${held.etag}"` } })
        : new Response('no such note', { status: 404 })
    }
    if (method === 'PUT') {
      // A folding filesystem stores under the name it already had, not the one
      // you sent — which is the whole point of the case this fixture serves.
      const stored = this.foldsCase ? notePath.toLowerCase() : notePath
      const ifMatch = new Headers(init?.headers).get('If-Match')
      if (ifMatch !== null && ifMatch !== (held?.etag ?? '')) {
        return new Response('etag is stale', {
          status: 409,
          headers: { etag: `"${held?.etag ?? ''}"` },
        })
      }
      const etag = `etag-${++this.#version}`
      this.files.set(stored, { body: String(init?.body ?? ''), etag })
      this.#remember(stored)
      return new Response('', { headers: { etag: `"${etag}"` } })
    }
    if (method === 'DELETE') {
      this.files.delete(notePath)
      return new Response(null, { status: 204 })
    }
    return new Response('no such endpoint', { status: 404 })
  }
}

class FakeSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    queueMicrotask(() => this.onopen?.())
  }
  receive(data: string): void {
    this.onmessage?.({ data })
  }
  close(): void {
    this.onclose?.()
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  })
}

const NOTE =
  '---\nref: 003\ntitle: Terminal aesthetics\nmodified: 2026-08-04T13:47:00Z\n---\nBody.\n'

let server: FakeVault
const realFetch = globalThis.fetch
const realSocket = globalThis.WebSocket

/** Let queued promises settle; the store chains several per action. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

beforeEach(() => {
  server = new FakeVault()
  server.install()
  // Reset the singleton between cases.
  vault.tree = []
  vault.corpus = {}
  vault.openPath = null
  vault.buffer = ''
  vault.etag = null
  vault.dirty = false
  vault.externalEdit = false
  vault.notice = null
})

afterEach(() => {
  vault.stop()
  globalThis.fetch = realFetch
  globalThis.WebSocket = realSocket
  Reflect.deleteProperty(globalThis, 'location')
  vi.useRealTimers()
})

describe('loading', () => {
  it('builds the tree and fills word counts behind it', async () => {
    server.seed('notes/003-terminal-aesthetics.md', NOTE)
    await vault.refresh()
    await settle()

    expect(vault.files).toBe(1)
    expect(vault.tree[0]?.ref).toBe('003')
    expect(vault.words('notes/003-terminal-aesthetics.md')).toBe(1)
  })

  it('opens a note with its etag', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')

    expect(vault.buffer).toBe(NOTE)
    expect(vault.etag).not.toBeNull()
    expect(vault.dirty).toBe(false)
  })
})

describe('save pipeline', () => {
  it('debounces for 500 ms and then writes once', async () => {
    vi.useFakeTimers()
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')
    server.requests.length = 0

    vault.edit(`${NOTE}one`)
    vault.edit(`${NOTE}two`)
    vault.edit(`${NOTE}three`)
    expect(server.requests.filter((r) => r.startsWith('PUT'))).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(499)
    expect(server.requests.filter((r) => r.startsWith('PUT'))).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(2)
    expect(server.requests.filter((r) => r.startsWith('PUT'))).toHaveLength(1)
    expect(server.files.get('notes/003-a.md')?.body).toContain('three')
  })

  it('still reaches disk under continuous typing', async () => {
    vi.useFakeTimers()
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')
    server.requests.length = 0

    // A keystroke every 100 ms re-arms a pure debounce forever, so without a
    // ceiling nothing would ever be written and §06's 600 ms budget — which
    // runs from the edit, not from the pause — would be missed indefinitely.
    for (let i = 0; i < 12; i++) {
      vault.edit(`${NOTE}keystroke ${i}`)
      await vi.advanceTimersByTimeAsync(100)
    }

    expect(server.requests.filter((r) => r.startsWith('PUT')).length).toBeGreaterThan(0)
    expect(server.files.get('notes/003-a.md')?.body).toContain('keystroke')
  })

  it('stamps modified and leaves every other byte alone', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')

    vault.edit(NOTE.replace('Body.', 'Edited.'))
    await vault.save()

    const written = server.files.get('notes/003-a.md')?.body ?? ''
    expect(written).toContain('Edited.')
    expect(written).toContain('title: Terminal aesthetics')
    expect(fields(written).get('modified')).not.toBe('2026-08-04T13:47:00Z')
  })

  it('sends If-Match so the server can refuse a stale write', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')
    const held = vault.etag

    vault.edit(`${NOTE}more`)
    await vault.save()

    expect(vault.etag).not.toBe(held)
    expect(vault.dirty).toBe(false)
  })
})

describe('conflict', () => {
  it('writes a conflict copy and adopts the disk version', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')

    // An agent writes underneath us, so our etag goes stale.
    server.seed('notes/003-a.md', `${NOTE}written by an agent\n`)

    vault.edit(`${NOTE}written by the human\n`)
    await vault.save()
    await settle()

    const copies = [...server.files.keys()].filter((path) => path.includes('.conflict-'))
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatch(/^notes\/003-a\.conflict-.*\.md$/)
    // Neither revision is lost: ours is in the copy, theirs is still at the path.
    expect(server.files.get(copies[0] ?? '')?.body).toContain('written by the human')
    expect(vault.buffer).toContain('written by an agent')
    expect(vault.dirty).toBe(false)
    expect(vault.notice).toContain('.conflict-')
  })
})

describe('resolving a conflict (§02b Screen 4)', () => {
  /** Drive the real 409 path, and hand back the copy it parked. */
  async function conflict(): Promise<string> {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')
    server.seed('notes/003-a.md', `${NOTE}from the agent\n`)
    vault.edit(`${NOTE}from the human\n`)
    await vault.save()
    // The store schedules its own refresh on a zero-delay timer, so let that run
    // rather than calling refresh() here: the tree arriving on its own is what
    // makes the copy discoverable without anyone being told about it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await settle()

    const copy = [...server.files.keys()].find((path) => path.includes('.conflict-'))
    // The rest of this block is meaningless if the 409 path did not run.
    expect(copy).toBeDefined()
    return copy ?? ''
  }

  it('lists the copy as unresolved, without being told one happened', async () => {
    const copy = await conflict()
    // Derived from the tree, so it survives what `notice` does not.
    vault.notice = null
    expect(vault.unresolved.map((one) => one.copy.path)).toEqual([copy])
    expect(vault.unresolved[0]?.from).toBe('notes/003-a.md')
  })

  it('writes the merge over the original and retires the copy', async () => {
    const copy = await conflict()
    const merged = `${NOTE}from the human\nfrom the agent\n`
    // So the empty list below is a change of state, not a list that was empty
    // all along.
    expect(vault.unresolved).toHaveLength(1)

    expect(await vault.resolveConflict(copy, merged)).toBe(true)
    await settle()

    expect(server.files.get('notes/003-a.md')?.body).toBe(merged)
    expect(server.files.has(copy)).toBe(false)
    expect(vault.unresolved).toEqual([])
  })

  it('writes the merge before deleting the copy, never the other way round', async () => {
    const copy = await conflict()
    server.requests.length = 0
    await vault.resolveConflict(copy, 'merged\n')

    const put = server.requests.indexOf('PUT /api/note/notes/003-a.md')
    const del = server.requests.findIndex((one) => one.startsWith('DELETE'))
    expect(put).toBeGreaterThanOrEqual(0)
    expect(del).toBeGreaterThanOrEqual(0)
    // A failure between the two must leave both revisions, not neither — which
    // §04's agent contract now states outright, so this order is a promise the
    // vault makes to whoever reads it rather than an implementation detail.
    expect(put).toBeLessThan(del)
  })

  it('updates the open buffer when the note being merged into is the open one', async () => {
    const copy = await conflict()
    expect(vault.openPath).toBe('notes/003-a.md')

    await vault.resolveConflict(copy, 'merged\n')
    expect(vault.buffer).toBe('merged\n')
    expect(vault.dirty).toBe(false)
  })

  it('merges nothing when the original moved again while it was being chosen', async () => {
    const copy = await conflict()
    // A third write lands after the table was built: our etag is stale again.
    server.seed('notes/003-a.md', `${NOTE}moved again\n`)

    expect(await vault.resolveConflict(copy, 'merged\n')).toBe(false)
    await settle()

    expect(server.files.get('notes/003-a.md')?.body).toContain('moved again')
    // Above all, the copy survives — it is still the only home of that text.
    expect(server.files.has(copy)).toBe(true)
    expect(vault.notice).toContain('changed again')
  })

  it('keeps the merge when the copy cannot be deleted', async () => {
    const copy = await conflict()
    const realFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'DELETE'
        ? Promise.resolve(new Response('busy', { status: 500 }))
        : realFetch(input, init)) as typeof fetch

    expect(await vault.resolveConflict(copy, 'merged\n')).toBe(true)
    globalThis.fetch = realFetch
    await settle()

    expect(server.files.get('notes/003-a.md')?.body).toBe('merged\n')
    expect(server.files.has(copy)).toBe(true)
    expect(vault.notice).toContain('remains')
  })

  it('refuses a path that is not a conflict copy, before writing anything', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    server.requests.length = 0

    expect(await vault.resolveConflict('notes/003-a.md', 'anything\n')).toBe(false)
    expect(server.files.get('notes/003-a.md')?.body).toBe(NOTE)
    // Returning false is not enough: without the guard the call still reaches
    // `putNote` and fails there by accident, on a malformed URL. The refusal has
    // to be the reason, so nothing may go out at all.
    expect(server.requests).toEqual([])
    expect(vault.notice).toContain('not a conflict copy')
  })

  it('refuses to overwrite an original whose body it never read', async () => {
    server.seed('notes/003-a.md', NOTE)
    server.seed('notes/003-a.conflict-20260808T172820123Z.md', 'mine\n')
    await vault.refresh()
    // The tree has both, but no body has landed — an unconditional PUT here
    // would replace a note this client has never seen.
    vault.corpus = {}

    const copy = 'notes/003-a.conflict-20260808T172820123Z.md'
    expect(await vault.resolveConflict(copy, 'merged\n')).toBe(false)
    expect(server.files.get('notes/003-a.md')?.body).toBe(NOTE)
    expect(vault.notice).toContain('Refusing')
  })

  it('creates the original when it has been removed, rather than refusing', async () => {
    // The copy is the only surviving revision at that point, so the merge has
    // nowhere to go but a fresh file.
    server.seed('notes/003-a.conflict-20260808T172820123Z.md', 'mine\n')
    await vault.refresh()
    await settle()

    const copy = 'notes/003-a.conflict-20260808T172820123Z.md'
    expect(vault.unresolved[0]?.original).toBeNull()
    expect(await vault.resolveConflict(copy, 'restored\n')).toBe(true)
    expect(server.files.get('notes/003-a.md')?.body).toBe('restored\n')
  })
})

describe('live socket', () => {
  /** Let a zero-delay timer run, then drain the promise chain it starts. */
  async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await settle()
  }

  it('connects, folds a real frame into the tree, and reports the watcher live', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.start()
    await tick()

    expect(vault.connected).toBe(true)
    expect(vault.files).toBe(1)

    // Delivered through the socket, not by calling apply() directly — so the
    // JSON parse, the handler wiring and the coalesced refresh are all covered.
    server.seed('notes/004-new.md', NOTE)
    server.emit({ type: 'created', path: 'notes/004-new.md', etag: 'etag-fresh' })
    await tick()

    expect(vault.files).toBe(2)
    expect(vault.tree.map((entry) => entry.path)).toContain('notes/004-new.md')
  })

  it('stops cleanly', async () => {
    await vault.start()
    await tick()
    vault.stop()
    expect(vault.connected).toBe(false)
  })
})

describe('refusing to lose work', () => {
  /** Make every request fail, as a stopped server or a dropped network would. */
  function breakTransport(): void {
    globalThis.fetch = (() => Promise.reject(new Error('network down'))) as typeof fetch
  }

  it('will not navigate away when the pending save failed', async () => {
    server.seed('notes/003-a.md', NOTE)
    server.seed('notes/004-b.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')

    vault.edit(`${NOTE}precious sentence`)
    breakTransport()
    await vault.open('notes/004-b.md')
    await settle()

    // The only copy of that sentence is the buffer, so it must survive.
    expect(vault.buffer).toContain('precious sentence')
    expect(vault.openPath).toBe('notes/003-a.md')
    expect(vault.dirty).toBe(true)
    expect(vault.notice).not.toBeNull()
  })

  it('does not bind openPath to a note it could not load', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    breakTransport()

    await vault.open('notes/003-a.md')
    await settle()

    // A live path with an empty buffer and a null etag would be written over
    // the real file by the next save, with no If-Match to stop it.
    expect(vault.openPath).toBeNull()
    expect(vault.etag).toBeNull()
    expect(vault.notice).not.toBeNull()
  })

  it('refuses to save a note that never loaded', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()

    // Force the state the old open() could produce.
    vault.openPath = 'notes/003-a.md'
    vault.buffer = 'junk'
    vault.etag = null
    vault.dirty = true

    expect(await vault.save()).toBe(false)
    expect(server.files.get('notes/003-a.md')?.body).toBe(NOTE)
  })

  it('rescues the buffer when the file is deleted underneath it', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')

    vault.edit(`${NOTE}two hours of writing`)
    server.files.delete('notes/003-a.md')
    vault.apply({ type: 'removed', path: 'notes/003-a.md', etag: null })
    await settle()

    const rescued = [...server.files.keys()].filter((path) => path.includes('.conflict-'))
    expect(rescued).toHaveLength(1)
    expect(server.files.get(rescued[0] ?? '')?.body).toContain('two hours of writing')
  })

  it('keeps two conflicts in the same second as two files', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')

    for (const revision of ['revision one', 'revision two']) {
      server.seed('notes/003-a.md', `${NOTE}an agent wrote\n`)
      vault.edit(`${NOTE}${revision}\n`)
      await vault.save()
      await settle()
    }

    const copies = [...server.files.keys()].filter((path) => path.includes('.conflict-'))
    expect(copies).toHaveLength(2)
    const bodies = copies.map((path) => server.files.get(path)?.body ?? '').join('\n')
    expect(bodies).toContain('revision one')
    expect(bodies).toContain('revision two')
  })

  it('does not manufacture a conflict from two concurrent saves', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')

    vault.edit(`${NOTE}typed once`)
    await Promise.all([vault.save(), vault.save(), vault.save()])
    await settle()

    expect([...server.files.keys()].filter((p) => p.includes('.conflict-'))).toHaveLength(
      0,
    )
    expect(vault.dirty).toBe(false)
  })
})

describe('wikilink resolution', () => {
  it('does not let a conflict copy shadow the note it came from', async () => {
    server.seed(
      'notes/003-a.md',
      '---\nref: 003\ntitle: Terminal aesthetics\n---\nmine\n',
    )
    server.seed(
      'notes/003-a.conflict-20260805T091640123Z.md',
      '---\nref: 003\ntitle: Terminal aesthetics\n---\ntheirs\n',
    )
    await vault.refresh()

    // The copy carries the same title verbatim, so without the guard it is a
    // coin flip which one [[Terminal aesthetics]] opens.
    expect(vault.resolve('Terminal aesthetics')?.path).toBe('notes/003-a.md')
    expect(vault.resolve('003')?.path).toBe('notes/003-a.md')
  })
})

describe('daily log', () => {
  const day = new Date('2026-08-05T09:16:40Z')

  it('creates it on first open, with no ref', async () => {
    await vault.refresh()
    await vault.openDaily(day)
    await settle()

    const created = server.files.get('daily/2026-08-05.md')
    expect(created).toBeDefined()
    // §04 gives daily logs their own filename shape; a date is not a ref, and
    // the server's allocator skips daily/ for exactly that reason.
    expect(created?.body).not.toContain('ref:')
    expect(fields(created?.body ?? '').get('title')).toBe('2026-08-05')
    expect(vault.openPath).toBe('daily/2026-08-05.md')
  })

  it('is idempotent — a second call opens the same note', async () => {
    await vault.refresh()
    await vault.openDaily(day)
    await settle()
    const first = server.files.get('daily/2026-08-05.md')?.body

    await vault.openDaily(day)
    await settle()

    expect([...server.files.keys()].filter((p) => p.startsWith('daily/'))).toHaveLength(1)
    expect(server.files.get('daily/2026-08-05.md')?.body).toBe(first)
  })

  it('does not consume a ref', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.openDaily(day)
    await settle()

    await vault.create('After the daily')
    await settle()
    expect(server.files.has('notes/004-after-the-daily.md')).toBe(true)
  })

  it('cuts it from templates/daily.md when there is one (§08 P7)', async () => {
    server.seed(
      'templates/daily.md',
      '---\nid: T\ntitle: T\ncreated: T\nmodified: T\ntags: [log]\n---\n## Log\n\n- [ ] \n',
    )
    await vault.refresh()
    await vault.openDaily(day)
    await settle()

    const created = server.files.get('daily/2026-08-05.md')?.body ?? ''
    expect(created).toContain('## Log')
    expect(fields(created).get('title')).toBe('2026-08-05')
    expect(fields(created).get('tags')).toBe('[log]')
    expect(fields(created).get('id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('stays idempotent with a template — the second call writes nothing', async () => {
    server.seed('templates/daily.md', '---\ntitle: T\n---\nfrom the stencil\n')
    await vault.refresh()
    await vault.openDaily(day)
    await settle()

    const first = server.files.get('daily/2026-08-05.md')?.body
    server.requests.length = 0
    await vault.openDaily(day)
    await settle()

    expect(server.files.get('daily/2026-08-05.md')?.body).toBe(first)
    expect(server.requests.filter((r) => r.startsWith('PUT'))).toEqual([])
  })

  it('refuses to write the day from the wrong stencil', async () => {
    // The template is in the tree but unreadable. Creating the note anyway would
    // produce a day the user cannot get back by pressing the key again — it
    // would already exist, and idempotency would return the wrong note forever.
    server.seed('templates/daily.md', 'ignored')
    server.fail('templates/daily.md', 500)
    await vault.refresh()
    await vault.openDaily(day)
    await settle()

    expect(server.files.has('daily/2026-08-05.md')).toBe(false)
    expect(vault.notice).not.toBeNull()
  })
})

describe('tasks', () => {
  const WITH_TASKS =
    '---\nref: 007\ntitle: Chores\nmodified: 2026-08-04T13:47:00Z\n---\n- [ ] one\n- [x] two\n'
  /** Offset of the first `[` in WITH_TASKS. */
  const FIRST = WITH_TASKS.indexOf('[ ]')

  it('writes a toggle through to the file it lives in (§08 P7)', async () => {
    server.seed('notes/007-chores.md', WITH_TASKS)
    await vault.refresh()
    await settle()

    expect(await vault.toggleTask('notes/007-chores.md', FIRST)).toBe(true)

    const written = server.files.get('notes/007-chores.md')?.body ?? ''
    expect(written).toContain('- [x] one')
    expect(written).toContain('- [x] two')
    // §04: `modified` is the one field the UI rewrites.
    expect(fields(written).get('modified')).not.toBe('2026-08-04T13:47:00Z')
  })

  it('unticks as readily as it ticks', async () => {
    server.seed('notes/007-chores.md', WITH_TASKS)
    await vault.refresh()
    await settle()

    const second = WITH_TASKS.indexOf('[x]')
    await vault.toggleTask('notes/007-chores.md', second)
    expect(server.files.get('notes/007-chores.md')?.body).toContain('- [ ] two')
  })

  it('edits the buffer, not the file, when the note is the open one', async () => {
    // The buffer may hold unsaved text. A write underneath it would either be
    // overwritten by the next debounced save or conflict the note with itself.
    vi.useFakeTimers()
    server.seed('notes/007-chores.md', WITH_TASKS)
    await vault.refresh()
    await vault.open('notes/007-chores.md')

    await vault.toggleTask('notes/007-chores.md', FIRST)
    expect(vault.buffer).toContain('- [x] one')
    expect(vault.dirty).toBe(true)
    // Nothing has reached disk yet; the ordinary save pipeline owns that.
    expect(server.files.get('notes/007-chores.md')?.body).toContain('- [ ] one')

    await vi.advanceTimersByTimeAsync(600)
    expect(server.files.get('notes/007-chores.md')?.body).toContain('- [x] one')
  })

  it('refuses when the line has moved, rather than rewriting prose', async () => {
    server.seed('notes/007-chores.md', WITH_TASKS)
    await vault.refresh()
    await settle()

    expect(await vault.toggleTask('notes/007-chores.md', FIRST + 1)).toBe(false)
    expect(server.files.get('notes/007-chores.md')?.body).toBe(WITH_TASKS)
    expect(vault.notice).toContain('Nothing toggled')
  })

  it('refuses when the note changed on disk, and loses nothing by it', async () => {
    server.seed('notes/007-chores.md', WITH_TASKS)
    await vault.refresh()
    await settle()

    // An agent rewrites the file; our etag is now stale.
    server.seed('notes/007-chores.md', `${WITH_TASKS}- [ ] three\n`)

    expect(await vault.toggleTask('notes/007-chores.md', FIRST)).toBe(false)
    expect(server.files.get('notes/007-chores.md')?.body).toContain('- [ ] three')
    expect(vault.notice).toContain('changed on disk')
  })

  it('serialises two toggles so the second is not a conflict with the first', async () => {
    server.seed('notes/007-chores.md', WITH_TASKS)
    await vault.refresh()
    await settle()

    const second = WITH_TASKS.indexOf('[x]')
    const [a, b] = await Promise.all([
      vault.toggleTask('notes/007-chores.md', FIRST),
      vault.toggleTask('notes/007-chores.md', second),
    ])

    expect([a, b]).toEqual([true, true])
    const written = server.files.get('notes/007-chores.md')?.body ?? ''
    expect(written).toContain('- [x] one')
    expect(written).toContain('- [ ] two')
  })
})

describe('external changes', () => {
  it('reloads a clean note in place', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')

    server.seed('notes/003-a.md', `${NOTE}appended by an agent\n`)
    vault.apply({ type: 'changed', path: 'notes/003-a.md', etag: 'etag-elsewhere' })
    await settle()

    expect(vault.buffer).toContain('appended by an agent')
    expect(vault.dirty).toBe(false)
  })

  it('never clobbers unsaved work', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')

    vault.edit(`${NOTE}my unsaved sentence`)
    server.seed('notes/003-a.md', `${NOTE}the agent's version\n`)
    vault.apply({ type: 'changed', path: 'notes/003-a.md', etag: 'etag-elsewhere' })
    await settle()

    expect(vault.buffer).toContain('my unsaved sentence')
    expect(vault.dirty).toBe(true)
    // Latched, not announced once: the status bar keeps showing EXTERNAL EDIT
    // until the user resolves it (P4).
    expect(vault.externalEdit).toBe(true)
  })

  it('reload from disk keeps the discarded buffer as a conflict copy', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')

    vault.edit(`${NOTE}work the user chose to discard`)
    server.seed('notes/003-a.md', `${NOTE}the agent's version\n`)
    vault.apply({ type: 'changed', path: 'notes/003-a.md', etag: 'etag-elsewhere' })
    await settle()
    expect(vault.externalEdit).toBe(true)

    await vault.reloadFromDisk()
    await settle()

    // The user asked to discard, but §04's doctrine is that no revision is
    // destroyed — one extra file beats somebody's lost writing.
    const copies = [...server.files.keys()].filter((path) => path.includes('.conflict-'))
    expect(copies).toHaveLength(1)
    expect(server.files.get(copies[0] ?? '')?.body).toContain('chose to discard')

    expect(vault.buffer).toContain("the agent's version")
    expect(vault.dirty).toBe(false)
    expect(vault.externalEdit).toBe(false)
  })

  it('ignores the echo of our own save', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')
    const ours = vault.etag ?? ''

    vault.apply({ type: 'changed', path: 'notes/003-a.md', etag: ours })
    await settle()

    expect(vault.buffer).toBe(NOTE)
  })

  it('closes a note that was removed on disk', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')

    server.files.delete('notes/003-a.md')
    vault.apply({ type: 'removed', path: 'notes/003-a.md', etag: null })
    await settle()

    expect(vault.openPath).toBeNull()
    expect(vault.notice).toContain('removed')
  })
})

describe('new note', () => {
  it('follows §04: highest ref plus one, conforming frontmatter', async () => {
    server.seed('notes/001-a.md', '---\nref: 001\n---\n')
    server.seed('notes/004-b.md', '---\nref: 004\n---\n')
    await vault.refresh()

    await vault.create('Terminal aesthetics')
    await settle()

    const created = server.files.get('notes/005-terminal-aesthetics.md')
    expect(created).toBeDefined()

    const read = fields(created?.body ?? '')
    expect(read.get('ref')).toBe('005')
    expect(read.get('id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(read.get('title')).toBe('Terminal aesthetics')
    expect(vault.openPath).toBe('notes/005-terminal-aesthetics.md')
  })

  it('allocates monotonically while the vault grows', async () => {
    await vault.refresh()
    for (let i = 0; i < 4; i++) {
      await vault.create(`Note ${i}`)
      await settle()
    }

    const refs = [...server.files.keys()]
      .map((path) => /(\d+)-/.exec(path)?.[1])
      .filter((ref): ref is string => ref !== undefined)
      .sort()
    expect(refs).toEqual(['000', '001', '002', '003'])
    expect(new Set(refs).size).toBe(refs.length)
  })

  it('leaves a gap in the middle alone', async () => {
    server.seed('notes/000-a.md', '---\nref: 000\n---\n')
    server.seed('notes/004-b.md', '---\nref: 004\n---\n')
    await vault.refresh()

    await vault.create('Next')
    await settle()

    // Highest plus one, not the first free slot: 001 stays unused.
    expect(server.files.has('notes/005-next.md')).toBe(true)
  })

  it('never reissues a ref, even after the highest note is deleted', async () => {
    server.seed('notes/000-a.md', '---\nref: 000\n---\n')
    server.seed('notes/003-highest.md', '---\nref: 003\n---\n')
    await vault.refresh()

    server.files.delete('notes/003-highest.md')
    await vault.refresh()
    await vault.create('After a deletion')
    await settle()

    // The server counts `.register/trash/` when allocating, so deleting 003
    // does not hand its ref back out. Under §04's original "highest EXISTING
    // + 1" this produced 001 — a live ref for a second note, silently
    // re-pointing any [[001]] wikilink at different prose.
    expect(server.files.has('notes/004-after-a-deletion.md')).toBe(true)
    expect(server.files.has('notes/001-after-a-deletion.md')).toBe(false)
  })

  it('counts notes, not the vault’s furniture', async () => {
    // The sidebar lists what this counts. A status bar claiming ten files above
    // an index showing eight rows is the app disagreeing with itself.
    server.seed('notes/003-a.md', NOTE)
    server.seed('CLAUDE.md', '# agent contract\n')
    server.seed('templates/daily.md', '---\ntitle: TEMPLATE\n---\n')
    await vault.refresh()
    await settle()

    expect(vault.tree).toHaveLength(3)
    expect(vault.files).toBe(1)
  })

  it('carries git state when the vault is a repository, and null when it is not', async () => {
    // §02b Screen 1 has a GIT field; until P12 nothing could fill it. An
    // unreadable shape has to read as "no git" rather than break the tree.
    await vault.refresh()
    expect(vault.git).toBeNull()

    server.git = {
      branch: 'main',
      clean: false,
      staged: 1,
      modified: 2,
      untracked: 0,
      ahead: 3,
    }
    await vault.refresh()
    expect(vault.git).toEqual({
      branch: 'main',
      clean: false,
      staged: 1,
      modified: 2,
      untracked: 0,
      ahead: 3,
    })

    // A server that predates the counts, or an envelope that is half
    // unreadable: the field degrades to a branchless, markless "there is a
    // repository here" rather than breaking the tree that carries it.
    server.git = { clean: true }
    await vault.refresh()
    expect(vault.git).toEqual({
      branch: null,
      clean: true,
      staged: 0,
      modified: 0,
      untracked: 0,
      ahead: null,
    })

    // Counts that are not counts. `-1` and `NaN` must not reach the label,
    // where they would render as `+-1` and `~NaN`.
    server.git = {
      branch: '',
      clean: false,
      staged: -1,
      modified: Number.NaN,
      untracked: 2.7,
    }
    await vault.refresh()
    expect(vault.git).toEqual({
      branch: null,
      clean: false,
      staged: 0,
      modified: 0,
      untracked: 2,
      ahead: null,
    })
  })

  it('reports the vault path for the status bar', async () => {
    await vault.refresh()
    expect(vault.vaultPath).toBe('/tmp/fake-vault')
  })
})

describe('trash', () => {
  it('drops what it held about a note it deleted', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')
    await settle()

    expect(await vault.trashNote('notes/003-a.md')).toBe(true)
    await settle()

    // The buffer is not left bound to a path with nothing behind it, and the
    // corpus does not keep answering ⌘K with a body the vault no longer has —
    // nothing else prunes it, since #fillCorpus only ever adds.
    expect(vault.openPath).toBe(null)
    expect(vault.buffer).toBe('')
    expect(vault.corpus['notes/003-a.md']).toBeUndefined()
    expect(vault.notice).toContain('.register/trash/')
  })

  it('does not save a dirty buffer on its way to deleting it', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')
    vault.edit(`${NOTE}Something typed.\n`)

    await vault.trashNote('notes/003-a.md')
    await settle()

    // A pending debounce firing after the delete would write the buffer back to
    // the path just emptied, resurrecting the note as a side effect of removing
    // it. The file must stay gone.
    expect(server.files.has('notes/003-a.md')).toBe(false)
    expect(vault.dirty).toBe(false)
  })

  it('reports what the server moved, not what the confirm guessed', async () => {
    server.seed('notes/projects/010-a.md', NOTE)
    server.seed('notes/projects/011-b.md', NOTE)
    await vault.refresh()
    await vault.open('notes/projects/010-a.md')
    await settle()

    expect(await vault.trashFolder('notes/projects')).toBe(true)
    await settle()

    // Two notes and the file the INDEX never drew. The count the reader agreed
    // to was 2; the truth is 2 and an image, and this is where they find out.
    expect(vault.notice).toContain('2 notes and 1 file')
    expect(vault.notice).toContain('.register/trash/1700')
    expect(vault.openPath).toBe(null)
    expect(vault.corpus['notes/projects/011-b.md']).toBeUndefined()
  })

  it('leaves a note open when it was not in the folder that went', async () => {
    server.seed('notes/projects/010-a.md', NOTE)
    server.seed('notes/007-elsewhere.md', NOTE)
    await vault.refresh()
    await vault.open('notes/007-elsewhere.md')
    await settle()

    await vault.trashFolder('notes/projects')
    await settle()

    expect(vault.openPath).toBe('notes/007-elsewhere.md')
    expect(vault.buffer).not.toBe('')
  })

  it('says so and changes nothing when the server refuses', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')
    await settle()

    expect(await vault.trashFolder('notes/nowhere')).toBe(false)
    expect(vault.notice).toContain('no such folder')
    expect(vault.openPath).toBe('notes/003-a.md')
  })
})

describe('creating into a folder', () => {
  it('writes the note where it was told to', async () => {
    await vault.refresh()
    await vault.create('Launch plan', undefined, 'notes/projects')
    await settle()

    expect(server.files.has('notes/projects/000-launch-plan.md')).toBe(true)
  })

  it('still takes the next ref in the register, wherever it lands', async () => {
    // `next_ref` walks the whole vault, so nesting changes where a note lives
    // and never what it is called.
    server.seed('notes/007-a.md', NOTE)
    await vault.refresh()
    await vault.create('Deep one', undefined, 'notes/projects/deep')
    await settle()

    expect(server.files.has('notes/projects/deep/008-deep-one.md')).toBe(true)
  })

  it('goes where notes have always gone when told nothing', async () => {
    await vault.refresh()
    await vault.create('Loose')
    await settle()

    expect(server.files.has('notes/000-loose.md')).toBe(true)
  })

  it('refuses a folder the INDEX cannot draw', async () => {
    // A note in `daily/` or `templates/` is isListed-hidden: it would be
    // written, and then appear to have done nothing.
    await vault.refresh()
    await vault.create('Sneaky', undefined, 'daily')
    await settle()

    expect(server.files.has('daily/000-sneaky.md')).toBe(false)
    expect(vault.notice).toContain('not a folder notes can go in')

    await vault.create('Sneaky', undefined, 'templates')
    await settle()
    expect(server.files.has('templates/000-sneaky.md')).toBe(false)
  })
})

describe('creating into a folder the server would rewrite', () => {
  it('refuses the furniture whatever case it is typed in', async () => {
    await vault.refresh()
    await vault.create('Sneaky', undefined, 'Templates')
    await settle()

    expect([...server.files.keys()].some((p) => /templates/i.test(p))).toBe(false)
    expect(vault.notice).toContain('not a folder notes can go in')
  })

  it('refuses a path that would leave the folder it names', async () => {
    // It never reached the server as `..`; fetch collapsed it in the URL, so
    // this can only be caught before the request is built.
    await vault.refresh()
    await vault.create('Sneaky', undefined, 'notes/../templates')
    await settle()

    expect([...server.files.keys()].some((p) => /templates/i.test(p))).toBe(false)
  })

  it('refuses a leading separator instead of blaming a note that never was', async () => {
    await vault.refresh()
    await vault.create('Loose', undefined, '/notes')
    await settle()

    expect(vault.notice).not.toContain('already exists')
    expect(vault.notice).toContain('not a folder notes can go in')
  })

  it('opens the path the server wrote, not the one that was typed', async () => {
    // Emulates a filesystem that folds case: the client asks for one string and
    // the vault ends up holding another. openPath is compared by string for the
    // active INDEX row, the folder reveal and the external-edit latch, so a
    // mismatch makes all three quietly stop working on the note just made.
    server.foldsCase = true
    await vault.refresh()
    await vault.create('Launch plan', undefined, 'notes/Projects')
    await settle()

    expect(vault.openPath).toBe('notes/projects/000-launch-plan.md')
    expect(vault.tree.some((entry) => entry.path === vault.openPath)).toBe(true)
  })
})

describe('what the on-disk checks are for', () => {
  it('opens a daily log the tree has not caught up with, rather than writing over it', async () => {
    // The whole reason `openDaily` asks the *disk* and not only the tree: an
    // agent can write today's log between the refresh and the check. Treating
    // the answer as a bare boolean made this branch unreachable — `!` on an
    // object is always false and is not a type error — so the stencil went
    // straight over a real day's writing.
    const day = new Date('2026-08-05T09:16:40Z')
    server.seed('templates/daily.md', '---\ntitle: TEMPLATE\n---\nStencil.\n')
    server.seed('daily/2026-08-05.md', '---\ntitle: 2026-08-05\n---\nA day of writing.\n')
    server.hideFromTree('daily/2026-08-05.md')
    await vault.refresh()

    await vault.openDaily(day)
    await settle()

    expect(server.files.get('daily/2026-08-05.md')?.body).toContain('A day of writing.')
    expect(server.files.get('daily/2026-08-05.md')?.body).not.toContain('Stencil.')
    expect(vault.openPath).toBe('daily/2026-08-05.md')
  })

  it('says what the server said when it refuses a name, not "already exists"', async () => {
    // A path the server will not accept never could have existed, and calling
    // that "already exists" sends the reader looking for a file.
    await vault.refresh()
    server.fail('notes/000-refused.md', 400)

    await vault.create('Refused')
    await settle()

    expect(vault.notice).not.toContain('already exists')
    expect(vault.notice).toContain('unreadable')
    expect(server.files.has('notes/000-refused.md')).toBe(false)
  })
})

describe('a deletion the tree has not caught up with', () => {
  it('does not report success while the tree still lists the note', async () => {
    // `refresh` abandons its result when a newer refresh supersedes it, and
    // deleting a file makes the watcher fire one. Ours can lose that race and
    // install nothing, so the tree still lists a note that is gone — and the UI
    // then puts focus on a row the next refresh destroys. Cost two red CI runs
    // that no local run reproduced.
    server.seed('notes/003-a.md', NOTE)
    server.seed('notes/004-b.md', NOTE)
    await vault.refresh()

    server.serveStaleTreeOnce()
    expect(await vault.trashNote('notes/003-a.md')).toBe(true)
    await settle()

    expect(vault.tree.map((entry) => entry.path)).not.toContain('notes/003-a.md')
  })

  it('holds for a folder too', async () => {
    server.seed('notes/projects/010-a.md', NOTE)
    server.seed('notes/007-loose.md', NOTE)
    await vault.refresh()

    server.serveStaleTreeOnce()
    expect(await vault.trashFolder('notes/projects')).toBe(true)
    await settle()

    expect(vault.tree.map((entry) => entry.path)).not.toContain('notes/projects/010-a.md')
    expect(vault.tree.map((entry) => entry.path)).toContain('notes/007-loose.md')
  })
})

describe('an equal etag is not proof that nothing happened', () => {
  // §04 states the rule the cheap tag depends on: `mtime + len` collides for two
  // bodies of identical length written inside one filesystem tick —
  // sub-microsecond on APFS, coarser on the ext4 under a Linux container. A
  // client that read equality as "unchanged" would drop that write silently,
  // which is the one way the collision loses writing rather than being untidy.
  it('reloads the open note on a changed frame carrying the tag it already holds', async () => {
    server.seed('notes/003-a.md', NOTE)
    await vault.refresh()
    await vault.open('notes/003-a.md')
    const held = vault.etag
    expect(held).not.toBeNull()

    // Same length, different bytes — the shape a colliding tag has. Written
    // straight into the fake's map so the tag does *not* move, which is the
    // whole condition being reproduced.
    const collided = `${NOTE.slice(0, -2)}Z\n`
    expect(collided).toHaveLength(NOTE.length)
    server.files.set('notes/003-a.md', { body: collided, etag: held as string })

    // The event reports the tag we already hold, exactly as a collision would.
    vault.apply({ type: 'changed', path: 'notes/003-a.md', etag: held })
    await settle()

    expect(vault.buffer, 'the collided write was dropped').toBe(collided)
  })
})
