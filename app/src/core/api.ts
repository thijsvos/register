/**
 * The whole server surface (§04). Seventeen endpoints, nothing else — refs,
 * links, tasks, tags and search are all client-side derivations of plain text.
 *
 * Eight until Rev O added `GET /api/file` and Rev P `DELETE /api/folder`, ten
 * until Rev Z added history, a version and the ledger; this count went stale
 * at the first of those, which is the argument for it being here at all rather
 * than left to the reader to take on trust. It went stale a second time — it
 * read thirteen while the router declared sixteen — so `tests/release.rs` now
 * reads this sentence against `src/server.rs` and fails the build when the two
 * disagree.
 *
 * Every read here has a second answer (§12, ADR-008): an export is this same
 * app opened from disk with the vault's answers inlined, and `payload` is where
 * they are. A served page has no payload and never takes those branches; an
 * export has no server and never takes the others. A write asked of an export
 * refuses with `READ_ONLY`, which every caller already reports as a notice.
 */
import { offline, payload, READ_ONLY } from './offline'

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
  /**
   * How many times the vault has changed since the server started (Rev X).
   *
   * The optimistic lock a *deletion* needs. Every write is guarded by an etag
   * and no deletion was, so a note an agent edited between the confirm being
   * drawn and answered was trashed carrying that edit — and an etag cannot
   * describe a subtree, so a folder deletion had nothing to be guarded by at
   * all.
   */
  rev: number
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

/**
 * What a frame reports. `checkpoint` is the odd one: not the vault moving but
 * its record of itself — a commit landed (§08 P12) — and it carries no path.
 */
export type ChangeKind = 'created' | 'changed' | 'removed' | 'checkpoint'

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
  // A `data:` URL the export carried, or the empty string for one it did not:
  // an `<img src="">` fetches nothing and reports an error, which is the path
  // by which a target the vault never had becomes a dotted, inert reference.
  if (payload) return payload.files[path] ?? ''
  return `/api/file/${urlPath(path)}`
}

/**
 * Whether the export left this file out.
 *
 * Only an export can answer before the browser tries: the served app learns a
 * target is missing when its `<img>` fails, and `media.svelte.ts` records that.
 * An export knows at load, because the binary either carried the bytes or did
 * not, and there is nothing to try.
 */
export function fileLeftOut(path: string): boolean {
  return payload !== null && !(path in payload.files)
}

async function refuse(response: Response): Promise<never> {
  throw new ApiError(
    response.status,
    (await response.text()).trim() || response.statusText,
  )
}

/** What a write is told in an export. Never reached on a served page. */
function readOnly(): Promise<never> {
  return Promise.reject(new ApiError(405, READ_ONLY))
}

export async function getTree(): Promise<Tree> {
  if (payload) return asTree(payload.tree)
  const response = await fetch('/api/tree')
  if (!response.ok) await refuse(response)
  return asTree(await response.json())
}

/**
 * The export's etag for a note: the tree's, so the corpus fill and the echo
 * check compare like with like. Built once, since every note asks.
 */
let exportEtags: Map<string, string> | null = null
function exportEtag(path: string): string {
  if (exportEtags === null) {
    exportEtags = new Map(
      asTree(payload?.tree).notes.map((entry) => [entry.path, entry.etag]),
    )
  }
  return exportEtags.get(path) ?? 'export'
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
  if (payload) {
    const raw = payload.notes[path]
    if (raw === undefined) throw new ApiError(404, `${path} is not in this export`)
    return loaded(path, raw, exportEtag(path))
  }
  const response = await fetch(noteUrl(path))
  if (!response.ok) await refuse(response)
  const etag = etagOf(response)
  if (etag === null) throw new ApiError(response.status, 'note came back with no etag')
  return loaded(path, await response.text(), etag)
}

/** A note's bytes as the editor holds them: LF, with the convention remembered. */
function loaded(path: string, raw: string, etag: string): Loaded {
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
  if (offline) return readOnly()
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
  if (offline) return readOnly()
  const response = await fetch('/api/reveal', { method: 'POST' })
  if (!response.ok) await refuse(response)
}

/**
 * A deletion refused because the vault moved under the confirm (§04 Rev X).
 *
 * Distinct from `ApiError` so the caller can re-ask rather than report: a stale
 * revision is not a failure, it is the question needing to be put again about
 * what the folder holds *now*.
 */
export class VaultMoved extends Error {
  constructor(readonly rev: number | null) {
    super('the vault changed while you were being asked')
    this.name = 'VaultMoved'
  }
}

/** The revision a delete was armed against, or undefined to go unguarded. */
export async function deleteNote(path: string, rev?: number): Promise<void> {
  if (offline) return readOnly()
  const response = await fetch(noteUrl(path), {
    method: 'DELETE',
    headers: rev === undefined ? {} : { 'If-Match': String(rev) },
  })
  if (response.status === 409) throw new VaultMoved(revisionOf(response))
  if (!response.ok) await refuse(response)
}

/** The revision the server reports on a refusal, so the retry is armed right. */
function revisionOf(response: Response): number | null {
  const etag = etagOf(response)
  if (etag === null) return null
  const parsed = Number.parseInt(etag, 10)
  return Number.isNaN(parsed) ? null : parsed
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
export async function deleteFolder(path: string, rev?: number): Promise<Trashed> {
  if (offline) return readOnly()
  const response = await fetch(`/api/folder/${urlPath(path)}`, {
    method: 'DELETE',
    headers: rev === undefined ? {} : { 'If-Match': String(rev) },
  })
  if (response.status === 409) throw new VaultMoved(revisionOf(response))
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
  // An export has no watcher and nothing to watch: the vault it was cut from
  // is wherever it was, and this file is a reading of it. Not even a first
  // attempt — its own policy says `connect-src 'none'`, and a socket that was
  // never opened is the only kind that policy has nothing to report about.
  if (offline) return () => {}

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
    // A server that predates Rev X sends no `rev`. Zero rather than a throw: a
    // deletion then sends a revision the server ignores, which is the same
    // unguarded behaviour it had before — and refusing to read the tree at all
    // would be a worse answer to an old server than working without the guard.
    rev: typeof value.rev === 'number' ? value.rev : 0,
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
  if (
    kind !== 'created' &&
    kind !== 'changed' &&
    kind !== 'removed' &&
    kind !== 'checkpoint'
  ) {
    return null
  }
  return {
    type: kind,
    path: value.path,
    etag: typeof value.etag === 'string' ? value.etag : null,
  }
}

// --------------------------------------------------------------- config + fonts

/** `.register/config.json` (§02b Screen 6). `{}` when the vault has no config. */
export async function getConfig(): Promise<unknown> {
  // An export carries no config: what it looks like on this machine is this
  // machine's to decide, and nothing decided elsewhere should travel in a file
  // meant to be handed on.
  if (offline) return {}
  const response = await fetch('/api/config')
  if (!response.ok) await refuse(response)
  return await response.json()
}

/**
 * Settings in an export are held for the session and written nowhere.
 *
 * Accepted rather than refused: the scheme, the face and the scale are all
 * applied to `<html>` before this is called, and the page is theirs until it is
 * closed. Screen 6 says so. Refusing would put a notice on a control that had
 * just worked, which is a worse account of what happened than silence.
 */
export async function putConfig(value: unknown): Promise<void> {
  if (offline) return
  const response = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })
  if (!response.ok) await refuse(response)
}

/** One deletion still in the trash (§02b Screen 9). */
export interface Bucket {
  /** The `<stamp>` directory name, and its identity in the API. */
  name: string
  /** Where its contents go back to, vault-relative. */
  paths: string[]
  notes: number
  /** Everything that is not a note — images above all. */
  files: number
  /** Whether every original path is free. False does not prevent a restore. */
  clear: boolean
}

/** What a restore put back, and what it could not. */
export interface Restored {
  restored: number
  /** Left in the bucket because something already lives there. */
  kept: number
}

export async function getTrash(): Promise<Bucket[]> {
  // The trash lives under `.register/`, which an export never reads.
  if (offline) return []
  const response = await fetch('/api/trash')
  if (!response.ok) await refuse(response)
  return (await response.json()) as Bucket[]
}

export async function restoreBucket(name: string): Promise<Restored> {
  if (offline) return readOnly()
  const response = await fetch(`/api/trash/${encodeURIComponent(name)}`, {
    method: 'POST',
  })
  if (!response.ok) await refuse(response)
  return (await response.json()) as Restored
}

/** Destroy a bucket. The one call in this API that really deletes. */
export async function purgeBucket(name: string): Promise<void> {
  if (offline) return readOnly()
  const response = await fetch(`/api/trash/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
  if (!response.ok) await refuse(response)
}

/**
 * Who a checkpoint said changed a note (§08 P12): through this app, from
 * outside it — an agent, an editor, a sync client — or both inside one
 * checkpoint. Never "human" or "agent": the server reports what it can see.
 */
export type Who = 'you' | 'outside' | 'both'

/** One commit's word on one note: a version of it, or a row of the ledger. */
export interface Version {
  sha: string
  /** Committed at, in seconds since the epoch, UTC. */
  at: number
  /** The note's path at that commit — a moved note is followed back under the name it had. */
  path: string
  /** What the checkpoint said, or null for a commit made by hand, reported as itself. */
  who: Who | null
  author: string
  subject: string
}

/** Every commit that touched a note, newest first. `[]` for a vault that keeps no history. */
export async function getHistory(path: string): Promise<Version[]> {
  // An export carries the vault as it was, not how it got there: `[]`, the
  // same measured absence a vault that keeps no history answers.
  if (offline) return []
  const response = await fetch(`/api/history/${urlPath(path)}`)
  if (!response.ok) await refuse(response)
  return (await response.json()) as Version[]
}

/**
 * A note as one commit held it.
 *
 * Line endings take the road `getNote` takes: a uniformly-CRLF body is read as
 * LF, so it can be diffed against the buffer and written back through
 * `putNote`, which restores the file's own convention. Nothing is recorded
 * about it here — the current file, not an old one, decides how the note is
 * encoded.
 */
export async function getVersion(sha: string, path: string): Promise<string> {
  if (offline) throw new ApiError(404, 'an export carries no history')
  const response = await fetch(`/api/version/${encodeURIComponent(sha)}/${urlPath(path)}`)
  if (!response.ok) await refuse(response)
  const raw = await response.text()
  return usesCrlf(raw) ? raw.replaceAll('\r\n', '\n') : raw
}

/** The vault's recent history, one row per note per commit, newest first. */
export async function getLedger(): Promise<Version[]> {
  if (offline) return []
  const response = await fetch('/api/ledger')
  if (!response.ok) await refuse(response)
  return (await response.json()) as Version[]
}

/**
 * Where the browser fetches the vault as one file (§12, ADR-008).
 *
 * A URL rather than a fetch, for `fileUrl`'s reason: the bytes are for the
 * browser's download, not for this page. Followed with a `download` attribute
 * the server's `Content-Disposition` already implies, so the page stays and
 * the file lands wherever downloads do — the server writes nothing anywhere.
 * `media` mirrors the CLI's flag; the faces always travel from here, because a
 * file made from the browser is a file made to be opened somewhere else.
 */
export function exportUrl(media: 'inline' | 'none' = 'inline'): string {
  return media === 'none' ? '/api/export?media=none' : '/api/export'
}

/** Every non-note file in the vault (§02b Screen 10). */
export async function getFiles(): Promise<string[]> {
  // What was carried, which is what Screen 10 can show. A file left out is
  // still referenced from its note and drawn there as missing.
  if (payload) return Object.keys(payload.files).sort()
  const response = await fetch('/api/files')
  if (!response.ok) await refuse(response)
  return (await response.json()) as string[]
}

/** What a move moved (§04 Rev Y). */
export interface Moved {
  from: string
  to: string
  notes: number
}

/**
 * Rename or move a note or a folder.
 *
 * One call for both, because on disk they are one operation. Refuses an occupied
 * destination rather than merging: §04 never destroys.
 */
export async function movePath(from: string, to: string): Promise<Moved> {
  if (offline) return readOnly()
  const response = await fetch('/api/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to }),
  })
  if (!response.ok) await refuse(response)
  return (await response.json()) as Moved
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
  if (offline) return {}
  const response = await fetch('/api/local')
  if (!response.ok) await refuse(response)
  return await response.json()
}

export async function putLocal(value: unknown): Promise<void> {
  // Held for the session, as `putConfig` says.
  if (offline) return
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
  // Never in an export, by rule 7 before anything else: the licensed face is
  // the user's, and a file made to be handed on must not carry it. The binary
  // does not read it; this side does not ask.
  if (offline) return null
  const response = await fetch('/api/font')
  if (response.status === 404) return null
  if (!response.ok) await refuse(response)
  return await response.arrayBuffer()
}

export async function putFont(bytes: ArrayBuffer): Promise<void> {
  if (offline) return readOnly()
  const response = await fetch('/api/font', { method: 'PUT', body: bytes })
  if (!response.ok) await refuse(response)
}

export async function deleteFont(): Promise<void> {
  if (offline) return readOnly()
  const response = await fetch('/api/font', { method: 'DELETE' })
  if (!response.ok) await refuse(response)
}
