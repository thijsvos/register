/**
 * The whole server surface (§04). Eight endpoints, nothing else — refs, links,
 * tasks, tags and search are all client-side derivations of plain text.
 */

/**
 * The body of `GET /api/tree` (§04).
 *
 * An envelope, not a bare array: where the vault lives and which ref a new note
 * must take are properties of the vault, not of any one note. `nextRef` is the
 * server's, not the client's, because only the server can see `.register/trash/`
 * and therefore only the server knows which refs have ever been used.
 */
export interface Tree {
  vault: string
  nextRef: string
  /** §08 P12: the vault's git state, or null when it is not a repository. */
  git: GitStatus | null
  notes: Entry[]
}

/** What §02b Screen 1's GIT field shows. Derived, never stored. */
export interface GitStatus {
  clean: boolean
  /** Commits the branch has that its upstream does not; null with no upstream. */
  ahead: number | null
}

/** One row of `GET /api/tree`. */
export interface Entry {
  path: string
  ref: string | null
  title: string | null
  tags: string[]
  /** Filesystem mtime, epoch milliseconds. */
  mtime: number
  size: number
  etag: string
}

export type ChangeKind = 'created' | 'changed' | 'removed'

/** One frame of `WS /api/events`. */
export interface VaultEvent {
  type: ChangeKind
  path: string
  etag: string | null
}

export interface Loaded {
  body: string
  etag: string
}

export type Saved =
  | { ok: true; etag: string }
  /** §04: a stale etag is a 409 carrying the current one. */
  | { ok: false; conflict: true; etag: string | null }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Percent-encode each segment but not the separators.
 *
 * A whole-path `encodeURIComponent` would turn `/` into `%2F`, which the server
 * decodes straight back into a real separator — so it would not protect
 * anything, and it would break every path that has a folder in it.
 */
function noteUrl(path: string): string {
  return `/api/note/${path.split('/').map(encodeURIComponent).join('/')}`
}

async function refuse(response: Response): Promise<never> {
  throw new ApiError(
    response.status,
    (await response.text()).trim() || response.statusText,
  )
}

export async function getTree(): Promise<Tree> {
  const response = await fetch('/api/tree')
  if (!response.ok) await refuse(response)
  return asTree(await response.json())
}

export async function getNote(path: string): Promise<Loaded> {
  const response = await fetch(noteUrl(path))
  if (!response.ok) await refuse(response)
  const etag = etagOf(response)
  if (etag === null) throw new ApiError(response.status, 'note came back with no etag')
  return { body: await response.text(), etag }
}

export async function putNote(path: string, body: string, etag?: string): Promise<Saved> {
  const response = await fetch(noteUrl(path), {
    method: 'PUT',
    headers: etag === undefined ? {} : { 'If-Match': etag },
    body,
  })
  if (response.status === 409) {
    return { ok: false, conflict: true, etag: etagOf(response) }
  }
  if (!response.ok) await refuse(response)

  const written = etagOf(response)
  if (written === null) throw new ApiError(response.status, 'write returned no etag')
  return { ok: true, etag: written }
}

/**
 * Ask the server to open the vault in the OS file manager (§08 P5).
 *
 * No parameters by design: the server reveals the vault it was launched with, so
 * the client cannot aim it at anything.
 */
export async function revealVault(): Promise<void> {
  const response = await fetch('/api/reveal', { method: 'POST' })
  if (!response.ok) await refuse(response)
}

export async function deleteNote(path: string): Promise<void> {
  const response = await fetch(noteUrl(path), { method: 'DELETE' })
  if (!response.ok) await refuse(response)
}

/**
 * Subscribe to vault events, reconnecting on drop.
 *
 * The server hangs up rather than let a lagging client fall silently out of
 * sync, so a reconnect is a normal event, not an error — and every reconnect
 * re-syncs from `/api/tree` via `onResync`.
 */
export function openEvents(handlers: {
  onEvent: (event: VaultEvent) => void
  onResync: () => void
  onConnected: (connected: boolean) => void
}): () => void {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${protocol}://${location.host}/api/events`

  let socket: WebSocket | null = null
  let retry: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const connect = () => {
    if (closed) return
    try {
      socket = new WebSocket(url)
    } catch {
      // `new WebSocket` throws — it does not fire `onerror` — when the socket is
      // refused before it opens, which a Content-Security-Policy that does not
      // cover `ws:` will do. Uncaught, that killed this function on the first
      // call: no handler ran, no retry was ever scheduled, and the WATCHER lamp
      // stayed dark for the rest of the session with nothing in the console
      // after the initial violation. The reconnect loop is the whole point of
      // this function, so it has to survive its own first attempt failing.
      handlers.onConnected(false)
      retry = setTimeout(connect, RECONNECT_MS)
      return
    }

    socket.onopen = () => {
      handlers.onConnected(true)
      // Whatever happened while we were away is invisible to us.
      handlers.onResync()
    }
    socket.onmessage = (message) => {
      let event: VaultEvent | null = null
      try {
        event = asEvent(JSON.parse(String(message.data)))
      } catch {
        event = null
      }
      // A frame we cannot read means our picture may be stale, so fall back to
      // re-reading the tree rather than letting `undefined` travel inward.
      if (event === null) handlers.onResync()
      else handlers.onEvent(event)
    }
    socket.onclose = () => {
      handlers.onConnected(false)
      if (!closed) retry = setTimeout(connect, RECONNECT_MS)
    }
    socket.onerror = () => socket?.close()
  }

  connect()

  return () => {
    closed = true
    clearTimeout(retry)
    socket?.close()
  }
}

const RECONNECT_MS = 1000

/**
 * The response's etag, or null when it carries none.
 *
 * Null rather than the empty string on purpose: an empty etag would flow into
 * `putNote`'s optional parameter, and a falsy check there would quietly drop the
 * `If-Match` header — downgrading a guarded write to an unconditional one at
 * exactly the moment the guard matters.
 */
function etagOf(response: Response): string | null {
  const raw = response.headers.get('etag')
  return raw === null ? null : raw.replace(/^W\//, '').replace(/^"|"$/g, '')
}

// Both ends of this API are ours, so a shape mismatch is a build-time bug —
// but validating at the boundary turns it into a clear error instead of an
// `undefined` surfacing three layers inside the store.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asTree(value: unknown): Tree {
  if (
    !isRecord(value) ||
    typeof value.vault !== 'string' ||
    typeof value.nextRef !== 'string' ||
    !Array.isArray(value.notes)
  ) {
    throw new ApiError(0, 'the vault tree came back in a shape this client cannot read')
  }
  return {
    vault: value.vault,
    nextRef: value.nextRef,
    git: asGit(value.git),
    notes: value.notes.map(asEntry).filter((entry): entry is Entry => entry !== null),
  }
}

function asGit(value: unknown): GitStatus | null {
  // Absent is the ordinary case — most vaults are not repositories — so an
  // unreadable shape reads as "no git", never as a broken tree.
  if (!isRecord(value) || typeof value.clean !== 'boolean') return null
  return {
    clean: value.clean,
    ahead: typeof value.ahead === 'number' ? value.ahead : null,
  }
}

function asEntry(value: unknown): Entry | null {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.etag !== 'string'
  ) {
    return null
  }
  return {
    path: value.path,
    ref: typeof value.ref === 'string' ? value.ref : null,
    title: typeof value.title === 'string' ? value.title : null,
    tags: Array.isArray(value.tags)
      ? value.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    mtime: typeof value.mtime === 'number' ? value.mtime : 0,
    size: typeof value.size === 'number' ? value.size : 0,
    etag: value.etag,
  }
}

function asEvent(value: unknown): VaultEvent | null {
  if (!isRecord(value) || typeof value.path !== 'string') return null
  const kind = value.type
  if (kind !== 'created' && kind !== 'changed' && kind !== 'removed') return null
  return {
    type: kind,
    path: value.path,
    etag: typeof value.etag === 'string' ? value.etag : null,
  }
}

// --------------------------------------------------------------- config + fonts

/** `.register/config.json` (§02b Screen 6). `{}` when the vault has no config. */
export async function getConfig(): Promise<unknown> {
  const response = await fetch('/api/config')
  if (!response.ok) await refuse(response)
  return await response.json()
}

export async function putConfig(value: unknown): Promise<void> {
  const response = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })
  if (!response.ok) await refuse(response)
}

/**
 * The licensed face's bytes, or null when none is loaded (§03 BYOF).
 *
 * Always same-origin: §08 P9 is explicit that fonts are never fetched from the
 * network, and the only place these bytes exist is the vault they were stored
 * in from the user's own disk.
 */
export async function getFont(): Promise<ArrayBuffer | null> {
  const response = await fetch('/api/font')
  if (response.status === 404) return null
  if (!response.ok) await refuse(response)
  return await response.arrayBuffer()
}

export async function putFont(bytes: ArrayBuffer): Promise<void> {
  const response = await fetch('/api/font', { method: 'PUT', body: bytes })
  if (!response.ok) await refuse(response)
}

export async function deleteFont(): Promise<void> {
  const response = await fetch('/api/font', { method: 'DELETE' })
  if (!response.ok) await refuse(response)
}
