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

  seed(path: string, body: string): void {
    this.files.set(path, { body, etag: `etag-${++this.#version}` })
    this.#remember(path)
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
      const tree = [...this.files.entries()]
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
      return json({ vault: '/tmp/fake-vault', nextRef: this.#nextRef(), notes: tree })
    }

    const notePath = decodeURIComponent(path.replace('/api/note/', ''))
    const held = this.files.get(notePath)

    if (method === 'GET') {
      return held
        ? new Response(held.body, { headers: { etag: `"${held.etag}"` } })
        : new Response('no such note', { status: 404 })
    }
    if (method === 'PUT') {
      const ifMatch = new Headers(init?.headers).get('If-Match')
      if (ifMatch !== null && ifMatch !== (held?.etag ?? '')) {
        return new Response('etag is stale', {
          status: 409,
          headers: { etag: `"${held?.etag ?? ''}"` },
        })
      }
      const etag = `etag-${++this.#version}`
      this.files.set(notePath, { body: String(init?.body ?? ''), etag })
      this.#remember(notePath)
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

  it('reports the vault path for the status bar', async () => {
    await vault.refresh()
    expect(vault.vaultPath).toBe('/tmp/fake-vault')
  })
})
