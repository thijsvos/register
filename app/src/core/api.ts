/**
 * The whole server surface (§04). Ten endpoints, nothing else — refs, links,
 * tasks, tags and search are all client-side derivations of plain text.
 *
 * Eight until Rev O added `GET /api/file` and Rev P `DELETE /api/folder`; this
 * count went stale at the first of those, which is the argument for it being
 * here at all rather than left to the reader to take on trust.
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
  /** The branch HEAD is on; null when detached. */
  branch: string | null
  clean: boolean
  /** Index against HEAD — `git status --short`'s first column, drawn `+`. */
  staged: number
  /** Worktree against the index — the second column, drawn `~`. */
  modified: number
  /** Paths git is not tracking — `??`, drawn `?`. */
  untracked: number
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
  return `/api/note/${urlPath(path)}`
}

/**
 * A vault path as URL path segments.
 *
 * Per segment, so the separators survive: `encodeURIComponent` on the whole
 * path would escape every `/` — see `noteUrl`'s note above for why that
 * protects nothing and breaks every path with a folder in it. Three routes
 * spell this now, which is one too many for a copy each.
 */
function urlPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * Where the browser fetches a file a note references (§04 Rev O).
 *
 * A URL rather than a fetch: an `<img src>` and an `<iframe src>` are how these
 * bytes are consumed, so handing back a string lets the browser do the
 * conditional request, the caching and the decoding — all of which it does
 * better than this module could, and none of which shows up in the bundle.
 */
export function fileUrl(path: string): string {
  return `/api/file/${urlPath(path)}`
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

/**
 * Notes whose bytes on disk use CRLF.
 *
 * CodeMirror has one line ending. `EditorState.lineSeparator` sets what the
 * *editor* inserts and splits on, but `doc.toString()` joins with `\n`
 * unconditionally — measured, because the obvious fix is to set that facet and
 * it does not work. So a CRLF note opened in the editor comes back out as LF,
 * and one keystroke rewrote every line ending in the file: a two-character edit
 * arriving as a whole-file diff in the vault's git history, on a vault the user
 * never asked to convert.
 *
 * Normalising here rather than fixing it at each write is what keeps the app to
 * **one coordinate system**. Offsets cross this boundary in both directions —
 * `bodyOffset` for the caret, the OUTLINE pane's `reveal`, `place()` coming back
 * — and if the buffer were CRLF while the editor's document were LF, every one
 * of them would need translating, each a place to be off by the number of CRs
 * above it. Converting the text once on the way in and once on the way out
 * leaves CRLF existing nowhere but the wire.
 *
 * Keyed by path and held here because this is the layer that owns how the file
 * is encoded, and because the alternative — threading a flag through `Loaded`,
 * the corpus, and every caller of `putNote` — puts the same fact in six places
 * and lets five of them go stale. Bounded by the vault: one boolean per note
 * ever opened.
 */
const crlfNotes = new Set<string>()

/** Uniformly CRLF: every `\n` is preceded by `\r`, and there is at least one. */
function usesCrlf(text: string): boolean {
  return text.includes('\r\n') && !/(?<!\r)\n/.test(text)
}

/** For tests, which must be able to start from nothing. */
export function forgetLineEndings(): void {
  crlfNotes.clear()
}

export async function getNote(path: string): Promise<Loaded> {
  const response = await fetch(noteUrl(path))
  if (!response.ok) await refuse(response)
  const etag = etagOf(response)
  if (etag === null) throw new ApiError(response.status, 'note came back with no etag')

  const raw = await response.text()
  // A mixed-ending file is left exactly as it is: there is no convention there
  // to preserve, and guessing one would be the app editing prose nobody asked
  // it to edit.
  if (usesCrlf(raw)) {
    crlfNotes.add(path)
    return { body: raw.replaceAll('\r\n', '\n'), etag }
  }
  crlfNotes.delete(path)
  return { body: raw, etag }
}

export async function putNote(path: string, body: string, etag?: string): Promise<Saved> {
  const response = await fetch(noteUrl(path), {
    method: 'PUT',
    headers: etag === undefined ? {} : { 'If-Match': etag },
    // Back into the file's own convention. A conflict copy of a CRLF note is
    // written by `#park` under a *different* path, which has never been read and
    // so is not in the set — it lands as LF, which is correct: it is a new file,
    // and a new file has no convention to keep.
    body: crlfNotes.has(path) ? body.replaceAll('\n', '\r\n') : body,
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

/** What a folder deletion moved (§04 Rev P). */
export interface Trashed {
  notes: number
  /** Everything else that went with it — media above all, which the INDEX never
   *  drew and the confirm therefore could not count. */
  files: number
  /** Vault-relative bucket it all landed in, for the notice to name. */
  bucket: string
}

/**
 * Trash a folder and everything under it (§04 Rev P).
 *
 * Its own route rather than a loop over `deleteNote`: one deletion is one trash
 * bucket, and a loop scatters a folder across as many as it held notes — see
 * `vault.rs::trash_folder` for the rest of that argument, including why the loop
 * cannot move the images either.
 */
export async function deleteFolder(path: string): Promise<Trashed> {
  const response = await fetch(`/api/folder/${urlPath(path)}`, { method: 'DELETE' })
  if (!response.ok) await refuse(response)
  return (await response.json()) as Trashed
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
    branch: typeof value.branch === 'string' && value.branch !== '' ? value.branch : null,
    clean: value.clean,
    staged: count(value.staged),
    modified: count(value.modified),
    untracked: count(value.untracked),
    ahead: typeof value.ahead === 'number' ? value.ahead : null,
  }
}

/**
 * A count from an envelope we did not write, or zero.
 *
 * Zero rather than null: a mark is drawn only when its count is above zero, so
 * an unreadable number has to mean "nothing to draw" — `NaN > 0` is false but
 * `NaN` would reach the label as `~NaN` if it were ever formatted directly.
 */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
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
 * `.register/local.json` — this machine's half of the settings (§04 Rev W).
 *
 * `config.json` is tracked, so everything in it was a diff: switching to dark
 * dirtied the vault, and committing it pushed your theme at whoever you shared
 * it with. The scheme, body face and plate scale describe the machine you are
 * sitting at — a 2x scale chosen on an ultrawide is vetoed on a laptop by the app
 * itself — while collapsed folders and the checkpoint flag describe the content
 * and should travel with it. Two files rather than one compromise that gets half
 * of them wrong.
 */
export async function getLocal(): Promise<unknown> {
  const response = await fetch('/api/local')
  if (!response.ok) await refuse(response)
  return await response.json()
}

export async function putLocal(value: unknown): Promise<void> {
  const response = await fetch('/api/local', {
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
