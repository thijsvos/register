/**
 * The whole server surface (§04). Five endpoints, nothing else — refs, links,
 * tasks, tags and search are all client-side derivations of plain text.
 */

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

export async function getTree(): Promise<Entry[]> {
  const response = await fetch('/api/tree')
  if (!response.ok) await refuse(response)
  return (await response.json()) as Entry[]
}

export async function getNote(path: string): Promise<Loaded> {
  const response = await fetch(noteUrl(path))
  if (!response.ok) await refuse(response)
  return { body: await response.text(), etag: etagOf(response) }
}

export async function putNote(path: string, body: string, etag?: string): Promise<Saved> {
  const response = await fetch(noteUrl(path), {
    method: 'PUT',
    headers: etag ? { 'If-Match': etag } : {},
    body,
  })
  if (response.status === 409) {
    return { ok: false, conflict: true, etag: etagOf(response) || null }
  }
  if (!response.ok) await refuse(response)
  return { ok: true, etag: etagOf(response) }
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
    socket = new WebSocket(url)

    socket.onopen = () => {
      handlers.onConnected(true)
      // Whatever happened while we were away is invisible to us.
      handlers.onResync()
    }
    socket.onmessage = (message) => {
      try {
        handlers.onEvent(JSON.parse(String(message.data)) as VaultEvent)
      } catch {
        // A frame we cannot read means our picture may be stale.
        handlers.onResync()
      }
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

function etagOf(response: Response): string {
  return (response.headers.get('etag') ?? '').replace(/^W\//, '').replace(/^"|"$/g, '')
}
