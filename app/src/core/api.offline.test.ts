/**
 * `api.ts` with a payload on the page (§12, ADR-008).
 *
 * The served path is proven by `store.test.ts` against a faked `fetch`. This
 * is the other half: with `offline.ts` reporting a payload, every read answers
 * from it, every write refuses with the one sentence, and nothing — not one
 * call — reaches `fetch` or `WebSocket`. Both globals are replaced with
 * functions that fail the test, so a branch that fell through to the wire
 * would be caught rather than merely observed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tree = {
  vault: 'vault',
  nextRef: '004',
  git: null,
  rev: 0,
  notes: [
    {
      path: 'notes/003-a.md',
      ref: '003',
      title: 'Alpha',
      tags: ['x'],
      mtime: 1,
      size: 10,
      etag: 'aaa-1',
    },
    {
      path: 'notes/004-crlf.md',
      ref: '004',
      title: 'Ends',
      tags: [],
      mtime: 1,
      size: 10,
      etag: 'bbb-2',
    },
  ],
}

vi.mock('./offline', () => ({
  PAYLOAD_ID: 'register-extract',
  READ_ONLY: 'An extract is read-only. Open the vault in REGISTER to write.',
  offline: true,
  payload: {
    tree,
    notes: {
      'notes/003-a.md': '---\ntitle: Alpha\n---\nBody.\n',
      'notes/004-crlf.md': '---\r\ntitle: Ends\r\n---\r\nOne.\r\n',
    },
    files: { 'notes/diagram.png': 'data:image/png;base64,iVBORw0KGgo=' },
    stamp: '2026-09-05T11:32:00Z',
  },
}))

const api = await import('./api')

const realFetch = globalThis.fetch
const realSocket = globalThis.WebSocket

beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error('an extract reached fetch')
  }) as typeof fetch
  globalThis.WebSocket = class {
    constructor() {
      throw new Error('an extract opened a socket')
    }
  } as unknown as typeof WebSocket
})
afterEach(() => {
  globalThis.fetch = realFetch
  globalThis.WebSocket = realSocket
})

describe('reads answer from the payload', () => {
  it('serves the tree the binary wrote', async () => {
    const got = await api.getTree()
    expect(got.vault).toBe('vault')
    expect(got.notes.map((entry) => entry.path)).toEqual([
      'notes/003-a.md',
      'notes/004-crlf.md',
    ])
    expect(got.git).toBeNull()
  })

  it('serves a note with the tree’s etag, so the corpus fill agrees with it', async () => {
    const loaded = await api.getNote('notes/003-a.md')
    expect(loaded).toEqual({ body: '---\ntitle: Alpha\n---\nBody.\n', etag: 'aaa-1' })
  })

  it('reads a CRLF note as LF, the way the served path does', async () => {
    const loaded = await api.getNote('notes/004-crlf.md')
    expect(loaded.body).toBe('---\ntitle: Ends\n---\nOne.\n')
    expect(loaded.etag).toBe('bbb-2')
  })

  it('answers 404 for a note the extract does not hold', async () => {
    await expect(api.getNote('notes/999-nope.md')).rejects.toMatchObject({
      status: 404,
    })
  })

  it('hands back a data: URL for a carried file and nothing for one left out', () => {
    expect(api.fileUrl('notes/diagram.png')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(api.fileUrl('notes/absent.png')).toBe('')
    expect(api.fileLeftOut('notes/absent.png')).toBe(true)
    expect(api.fileLeftOut('notes/diagram.png')).toBe(false)
  })

  it('lists the carried files, and no history, trash or config', async () => {
    expect(await api.getFiles()).toEqual(['notes/diagram.png'])
    expect(await api.getHistory('notes/003-a.md')).toEqual([])
    expect(await api.getLedger()).toEqual([])
    expect(await api.getTrash()).toEqual([])
    expect(await api.getConfig()).toEqual({})
    expect(await api.getLocal()).toEqual({})
    expect(await api.getFont()).toBeNull()
    await expect(api.getVersion('abc', 'notes/003-a.md')).rejects.toMatchObject({
      status: 404,
    })
  })

  it('never opens the socket', () => {
    const connected = vi.fn()
    const stop = api.openEvents({
      onEvent: vi.fn(),
      onResync: vi.fn(),
      onConnected: connected,
    })
    expect(connected).not.toHaveBeenCalled()
    stop()
  })
})

describe('writes refuse with the one sentence', () => {
  const READ_ONLY = 'An extract is read-only. Open the vault in REGISTER to write.'

  it.each([
    ['putNote', () => api.putNote('notes/003-a.md', 'x', 'aaa-1')],
    ['deleteNote', () => api.deleteNote('notes/003-a.md', 0)],
    ['deleteFolder', () => api.deleteFolder('notes', 0)],
    ['movePath', () => api.movePath('notes/003-a.md', 'archive/003-a.md')],
    ['restoreBucket', () => api.restoreBucket('1')],
    ['purgeBucket', () => api.purgeBucket('1')],
    ['putFont', () => api.putFont(new ArrayBuffer(4))],
    ['deleteFont', () => api.deleteFont()],
    ['revealVault', () => api.revealVault()],
  ])('%s', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ status: 405, message: READ_ONLY })
  })

  it('holds settings for the page rather than refusing them', async () => {
    // Screen 6's controls have already applied themselves to <html> by the
    // time these are called; a refusal would put a notice on a control that
    // just worked.
    await expect(api.putConfig({ collapsed: [] })).resolves.toBeUndefined()
    await expect(api.putLocal({ scheme: 'dark' })).resolves.toBeUndefined()
  })
})
