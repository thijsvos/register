import { afterEach, describe, expect, it, vi } from 'vitest'
import { getNote, openEvents, putNote } from './api'

/**
 * `openEvents`' reconnect loop, which is the only state machine in the client
 * and had no test at all.
 *
 * The happy paths are already driven end to end by `store.test.ts`, which walks
 * the real module through a `FakeVault`. What that cannot reach is failure: its
 * socket always opens, never errors, and never refuses to be constructed. Every
 * case below is one of those, and the first is a bug that shipped.
 */

/** A socket that does nothing until a test tells it to. */
class Socket {
  static live: Socket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    Socket.live.push(this)
  }
  close(): void {
    this.closed = true
    this.onclose?.()
  }
}

/** How many sockets a run has constructed — the reconnect count, in effect. */
function attempts(): number {
  return Socket.live.length
}

const realSocket = globalThis.WebSocket

/**
 * Install a WebSocket global. `throwing` reproduces a refusal that happens
 * before the socket exists — a Content-Security-Policy that does not cover
 * `ws:`, which is what v0.3.0 shipped.
 */
function install(options: { throwing?: boolean } = {}): void {
  Socket.live = []
  globalThis.WebSocket = class extends Socket {
    constructor(url: string | URL) {
      super(String(url))
      if (options.throwing) throw new Error('refused by Content-Security-Policy')
    }
  } as unknown as typeof WebSocket

  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { protocol: 'http:', host: 'localhost:7777' },
  })
}

function handlers() {
  return {
    events: [] as unknown[],
    resyncs: 0,
    connected: [] as boolean[],
    get spec() {
      return {
        onEvent: (event: unknown) => {
          this.events.push(event)
        },
        onResync: () => {
          this.resyncs += 1
        },
        onConnected: (state: boolean) => {
          this.connected.push(state)
        },
      }
    },
  }
}

afterEach(() => {
  globalThis.WebSocket = realSocket
  Reflect.deleteProperty(globalThis, 'location')
  vi.useRealTimers()
})

describe('openEvents when the socket cannot be constructed', () => {
  it('reports disconnected and keeps retrying instead of dying', async () => {
    // The v0.3.0 regression, fixed in 973960e. `new WebSocket` THROWS when the
    // connection is refused before it opens — it does not fire `onerror` — and
    // nothing caught it, so the very first call to `connect()` died, no retry
    // was ever scheduled, and the WATCHER lamp stayed dark for the whole
    // session with nothing in the console after the initial violation.
    vi.useFakeTimers()
    install({ throwing: true })
    const h = handlers()

    const stop = openEvents(h.spec)

    expect(h.connected, 'a refused socket must report disconnected').toEqual([false])
    expect(attempts(), 'one attempt so far').toBe(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(attempts(), 'the retry never fired; the loop is dead').toBe(2)

    await vi.advanceTimersByTimeAsync(1000)
    expect(attempts(), 'it retries for as long as it is refused').toBe(3)

    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(attempts(), 'it kept retrying after teardown').toBe(3)
  })

  it('tears down cleanly even though no socket was ever assigned', () => {
    // `socket` is still null on this path, so the optional call in the teardown
    // is load-bearing rather than decorative.
    vi.useFakeTimers()
    install({ throwing: true })
    const stop = openEvents(handlers().spec)
    expect(() => stop()).not.toThrow()
  })
})

describe('openEvents when the socket opens and then drops', () => {
  it('reconnects, and stops reconnecting once torn down', async () => {
    vi.useFakeTimers()
    install()
    const h = handlers()
    const stop = openEvents(h.spec)

    const first = Socket.live[0]
    first?.onopen?.()
    expect(h.connected).toEqual([true])
    expect(h.resyncs, 'a fresh connection has missed whatever happened').toBe(1)

    // The server restarts, or the network blinks.
    first?.close()
    expect(h.connected).toEqual([true, false])

    await vi.advanceTimersByTimeAsync(1000)
    expect(attempts(), 'a dropped socket must be replaced').toBe(2)

    Socket.live[1]?.onopen?.()
    expect(h.connected).toEqual([true, false, true])
    expect(h.resyncs, 'every reconnect resyncs, because we were away').toBe(2)

    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(attempts()).toBe(2)
  })

  it('closes the socket on error, which is what triggers the reconnect', () => {
    install()
    const h = handlers()
    openEvents(h.spec)

    const socket = Socket.live[0]
    socket?.onopen?.()
    socket?.onerror?.()

    expect(socket?.closed, 'onerror must close, or nothing schedules a retry').toBe(true)
  })
})

describe('openEvents when a frame cannot be trusted', () => {
  const cases: [string, string][] = [
    ['unparseable JSON', 'not json at all'],
    ['valid JSON, wrong shape', '{"nope":1}'],
    ['a path that is not a string', '{"type":"changed","path":42}'],
    ['a type nobody sends', '{"type":"exploded","path":"notes/003-a.md"}'],
  ]

  it.each(cases)('resyncs rather than passing %s inward', (_case, payload) => {
    // "A frame we cannot read means our picture may be stale, so fall back to
    // re-reading the tree rather than letting `undefined` travel inward."
    install()
    const h = handlers()
    openEvents(h.spec)

    const socket = Socket.live[0]
    socket?.onopen?.()
    const resyncsAfterOpen = h.resyncs

    socket?.onmessage?.({ data: payload })

    expect(h.events, 'a frame we cannot read must not reach the store').toEqual([])
    expect(h.resyncs).toBe(resyncsAfterOpen + 1)
  })

  it('passes a frame it can read straight through', () => {
    // The positive control: the four cases above would all pass against a
    // handler that resynced unconditionally and never delivered anything.
    install()
    const h = handlers()
    openEvents(h.spec)

    const socket = Socket.live[0]
    socket?.onopen?.()
    socket?.onmessage?.({
      data: '{"type":"changed","path":"notes/003-a.md","etag":"abc"}',
    })

    expect(h.events).toEqual([{ type: 'changed', path: 'notes/003-a.md', etag: 'abc' }])
  })
})

describe('the socket URL', () => {
  it('follows the page from http to ws and https to wss', () => {
    // A page served over TLS that opens a `ws://` socket is blocked as mixed
    // content, and remote mode behind a TLS-terminating proxy is exactly where
    // that would first be noticed.
    for (const [protocol, expected] of [
      ['http:', 'ws://localhost:7777/api/events'],
      ['https:', 'wss://localhost:7777/api/events'],
    ]) {
      install()
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { protocol, host: 'localhost:7777' },
      })
      openEvents(handlers().spec)
      expect(Socket.live[0]?.url).toBe(expected)
    }
  })
})

/**
 * `etagOf` and `noteUrl` are private, so they are reached through the two
 * functions that expose their results. Both carry a documented contract that
 * nothing exercised.
 */
const realFetch = globalThis.fetch

/** Serve one response and record the URL and headers the client sent. */
function serveOnce(response: Response) {
  // `undefined` rather than optional keys: `exactOptionalPropertyTypes` is on,
  // and "the header was absent" is a value this test asserts on rather than a
  // property that happens to be missing.
  const seen: { url: string | undefined; headers: HeadersInit | undefined } = {
    url: undefined,
    headers: undefined,
  }
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(input)
    seen.headers = init?.headers
    return Promise.resolve(response)
  }) as typeof fetch
  return seen
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('etagOf', () => {
  it.each([
    ['a quoted etag', '"abc123"', 'abc123'],
    ['a weak etag', 'W/"abc123"', 'abc123'],
    ['a bare etag', 'abc123', 'abc123'],
  ])('unwraps %s', async (_case, header, expected) => {
    // The weak form has never executed under test: `store.test.ts`'s FakeVault
    // only ever sends `"etag-N"`. A server that starts answering `W/"…"` — any
    // proxy that transforms bodies will — would otherwise hand the client an
    // etag with three extra characters, and every conditional write would 409.
    serveOnce(new Response('body', { status: 200, headers: { etag: header } }))
    await expect(getNote('notes/003-a.md')).resolves.toEqual({
      body: 'body',
      etag: expected,
    })
  })

  it('refuses a note with no etag rather than returning an empty one', async () => {
    // `null`, not `''`. The docstring argues this at length: an empty string
    // would flow into `putNote`'s optional parameter, and a falsy check there
    // would drop the `If-Match` header — downgrading a guarded write to an
    // unconditional one at exactly the moment the guard matters.
    serveOnce(new Response('body', { status: 200 }))
    await expect(getNote('notes/003-a.md')).rejects.toThrow(/no etag/)
  })

  it('reports a conflict as a value, with whatever etag came back', async () => {
    // A 409 must not throw: the store branches on it to write a conflict copy.
    serveOnce(new Response('stale', { status: 409, headers: { etag: 'W/"current"' } }))
    await expect(putNote('notes/003-a.md', 'body', 'mine')).resolves.toEqual({
      ok: false,
      conflict: true,
      etag: 'current',
    })
  })

  it('reports a conflict even when the server sends no etag', async () => {
    serveOnce(new Response('stale', { status: 409 }))
    await expect(putNote('notes/003-a.md', 'body', 'mine')).resolves.toEqual({
      ok: false,
      conflict: true,
      etag: null,
    })
  })
})

describe('noteUrl', () => {
  it.each([
    ['a space', 'notes/a b.md', '/api/note/notes/a%20b.md'],
    ['a hash', 'notes/a#b.md', '/api/note/notes/a%23b.md'],
    ['a percent', 'notes/100%.md', '/api/note/notes/100%25.md'],
    ['a question mark', 'notes/a?b.md', '/api/note/notes/a%3Fb.md'],
    ['non-ascii', 'notes/ünïcode.md', '/api/note/notes/%C3%BCn%C3%AFcode.md'],
  ])('encodes %s', async (_case, path, expected) => {
    const seen = serveOnce(new Response('x', { status: 200, headers: { etag: 'e' } }))
    await getNote(path)
    expect(seen.url).toBe(expected)
  })

  it('encodes each segment but never the separators', async () => {
    // The whole point, per the docstring: a whole-path `encodeURIComponent`
    // would turn every `/` into `%2F` and break every path with a folder in it —
    // which is all of them, since §04 puts notes under `notes/`.
    const seen = serveOnce(new Response('x', { status: 200, headers: { etag: 'e' } }))
    await getNote('daily/2026-08-08.md')
    expect(seen.url).toBe('/api/note/daily/2026-08-08.md')
    expect(seen.url).not.toContain('%2F')
  })
})

describe('putNote conditional writes', () => {
  it('sends If-Match when it holds an etag, and omits it when it does not', async () => {
    // The difference between "save this version" and "save over whatever is
    // there", which is the whole of §04's conflict story.
    const guarded = serveOnce(new Response('', { status: 200, headers: { etag: 'new' } }))
    await putNote('notes/003-a.md', 'body', 'held')
    expect(guarded.headers).toEqual({ 'If-Match': 'held' })

    const unguarded = serveOnce(
      new Response('', { status: 200, headers: { etag: 'new' } }),
    )
    await putNote('notes/003-a.md', 'body')
    expect(unguarded.headers).toEqual({})
  })

  it('refuses a write that came back with no etag', async () => {
    serveOnce(new Response('', { status: 200 }))
    await expect(putNote('notes/003-a.md', 'body')).rejects.toThrow(/no etag/)
  })
})
