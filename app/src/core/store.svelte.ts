import { isoStamp } from '../lib/time'
import {
  ApiError,
  type Entry,
  getNote,
  getTree,
  openEvents,
  putNote,
  type VaultEvent,
} from './api'
import { touchModified, wordCount } from './frontmatter'
import { newNote, notePath } from './refs'

/** §08 P3: "save pipeline debounced 500 ms with etag". */
const SAVE_DEBOUNCE_MS = 500

/**
 * Ceiling on how long an edit may sit unsaved, measured from the first
 * keystroke that dirtied the buffer.
 *
 * A pure debounce re-arms on every keystroke, so someone typing steadily —
 * faster than one key per 500 ms, which is ordinary prose speed — is never idle
 * long enough to trigger a write, and a whole session can exist only in RAM.
 *
 * Set equal to the debounce rather than higher, because §06 budgets a UI edit to
 * disk at 600 ms and that clock starts when the edit happens, not when the user
 * pauses. The effect is a flush every 500 ms during continuous typing, which
 * measures ~508 ms including the PUT — so the budget holds unconditionally
 * instead of only when someone stops to think.
 */
const SAVE_MAX_WAIT_MS = SAVE_DEBOUNCE_MS

/** Parallel body fetches when filling the corpus. */
const CORPUS_CONCURRENCY = 8

/**
 * Coalesce tree refreshes across one burst of events without adding latency.
 * The server already batches at 50 ms and §06 budgets 100 ms from an agent's
 * write to the repaint, so there is no room for a second real delay here — a
 * zero-delay timer only merges events that arrive in the same tick.
 */
const REFRESH_COALESCE_MS = 0

interface Held {
  body: string
  etag: string
}

class VaultStore {
  /** Every note, from `/api/tree`. The sidebar's only source. */
  tree = $state<Entry[]>([])
  /** Note bodies, filled in behind the tree so the sidebar paints first. */
  corpus = $state<Record<string, Held>>({})

  openPath = $state<string | null>(null)
  buffer = $state('')
  etag = $state<string | null>(null)
  dirty = $state(false)

  /** Where the vault lives, for the status bar. Reported by the server (§04). */
  vaultPath = $state<string | null>(null)
  /** The ref a new note must take. The server owns it: only it sees the trash. */
  nextRef = $state<string | null>(null)

  /**
   * The note changed on disk while the buffer was dirty (P4).
   *
   * Distinct from `notice`, which is transient prose: this is a latched state
   * the status bar shows until it is resolved, either by saving — which takes
   * the §04 conflict path — or by reloading from disk.
   */
  externalEdit = $state(false)

  /** One line of instrument-voiced status, or nothing. */
  notice = $state<string | null>(null)
  connected = $state(false)

  /** Conflict copies written this session. The tree lags a refresh behind. */
  #parked = new Set<string>()
  #saving: Promise<boolean> | null = null
  #dirtySince = 0
  #refreshTicket = 0
  #stopped = false
  #saveTimer: ReturnType<typeof setTimeout> | undefined
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #disconnect: (() => void) | undefined
  /** Guards against a slow fetch landing after the user moved on. */
  #generation = 0

  get files(): number {
    return this.tree.length
  }

  get active(): Entry | null {
    return this.tree.find((entry) => entry.path === this.openPath) ?? null
  }

  /**
   * Resolve a `[[wikilink]]` by title or ref — §04 allows either.
   *
   * Ref first: a ref is immutable and unique, a title is neither.
   */
  resolve(target: string): Entry | null {
    const wanted = target.trim()
    const lowered = wanted.toLowerCase()
    return (
      this.tree.find((entry) => entry.ref === wanted) ??
      this.tree.find((entry) => (entry.title ?? '').toLowerCase() === lowered) ??
      null
    )
  }

  /** Follow a wikilink, creating the note if it does not exist (§02b). */
  async follow(target: string): Promise<void> {
    const found = this.resolve(target)
    if (found !== null) {
      await this.open(found.path)
      return
    }
    await this.create(target.trim())
  }

  /** Live word count of the open buffer, for the status bar. */
  get openWords(): number | null {
    return this.openPath === null ? null : wordCount(this.buffer)
  }

  /** Words in a note, or null until its body has loaded. */
  words(path: string): number | null {
    const held = this.corpus[path]
    return held ? wordCount(held.body) : null
  }

  async start(): Promise<void> {
    this.#stopped = false
    await this.refresh()
    // A stop() arriving during that first fetch would have found #disconnect
    // still undefined and left the socket running for the process's lifetime.
    if (this.#stopped) return
    this.#disconnect = openEvents({
      onEvent: (event) => this.apply(event),
      // Every reconnect re-syncs: whatever happened while the socket was down
      // is invisible to us, and the server hangs up on a lagging client rather
      // than let it drift.
      onResync: () => this.#scheduleRefresh(),
      onConnected: (connected) => {
        this.connected = connected
      },
    })
  }

  stop(): void {
    this.#stopped = true
    this.#disconnect?.()
    this.#disconnect = undefined
    clearTimeout(this.#saveTimer)
    clearTimeout(this.#refreshTimer)
  }

  async refresh(): Promise<void> {
    // Two overlapping refreshes complete in any order, so the older one must not
    // be allowed to install the staler tree.
    const ticket = ++this.#refreshTicket
    try {
      const tree = await getTree()
      if (ticket !== this.#refreshTicket) return
      this.tree = tree.notes
      this.vaultPath = tree.vault
      this.nextRef = tree.nextRef
    } catch (error) {
      this.notice = describe(error)
      return
    }
    void this.#fillCorpus()
  }

  async open(path: string): Promise<void> {
    // A failed save leaves the only copy of the user's text in the buffer we
    // are about to replace, so a refused save refuses the navigation too.
    if (this.dirty && !(await this.save())) return

    const generation = ++this.#generation
    let loaded: Held
    try {
      loaded = await getNote(path)
    } catch (error) {
      // openPath is deliberately not moved. Binding it to a note we could not
      // load would leave a live path holding a foreign buffer and a null etag,
      // and the next debounced save would write that straight over the file.
      if (generation === this.#generation) this.notice = describe(error)
      return
    }
    if (generation !== this.#generation) return

    // Load first, commit second.
    this.openPath = path
    this.#adopt(path, loaded)
    this.notice = null
  }

  /** Record an edit and arm the debounced save. */
  edit(text: string): void {
    if (this.openPath === null) return
    this.buffer = text
    if (!this.dirty) {
      this.dirty = true
      this.#dirtySince = Date.now()
    }

    clearTimeout(this.#saveTimer)
    // Debounce, but never past the ceiling: steady typing must still reach disk.
    const waited = Date.now() - this.#dirtySince
    const delay = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS - waited))
    this.#saveTimer = setTimeout(() => void this.save(), delay)
  }

  /**
   * Flush the buffer. Returns whether the vault now holds what the user typed.
   *
   * Callers must honour a `false`: it means the text exists only in memory, so
   * anything that would replace the buffer has to stand down.
   */
  async save(): Promise<boolean> {
    clearTimeout(this.#saveTimer)
    // Without this, two callers both read `dirty`, both send the same stale
    // etag, and the loser answers its own duplicate write by manufacturing a
    // conflict copy of the note against itself.
    while (this.#saving !== null) await this.#saving
    const path = this.openPath
    if (path === null || !this.dirty) return true

    this.#saving = this.#writeOnce(path)
    try {
      return await this.#saving
    } finally {
      this.#saving = null
    }
  }

  async #writeOnce(path: string): Promise<boolean> {
    // A null etag means this note never loaded. `putNote` without If-Match
    // writes unconditionally (§04: "Missing path ⇒ create"), so saving here
    // would replace the file with a buffer that never came from it.
    if (this.etag === null && this.tree.some((entry) => entry.path === path)) {
      this.notice = 'Not loaded. Refusing to overwrite what is on disk.'
      return false
    }

    // The one field the UI may rewrite (§04). Everything else round-trips byte
    // for byte, so an agent's formatting survives our save untouched.
    const outgoing = touchModified(this.buffer, isoStamp())
    if (outgoing !== this.buffer) this.buffer = outgoing

    let result: Awaited<ReturnType<typeof putNote>>
    try {
      result = await putNote(path, outgoing, this.etag ?? undefined)
    } catch (error) {
      this.notice = describe(error)
      return false
    }

    // The write landed, but the user has moved on — leave their new note alone.
    if (this.openPath !== path) return true

    if (result.ok) {
      this.etag = result.etag
      this.corpus[path] = { body: outgoing, etag: result.etag }
      // Only clean if nothing was typed while the request was in flight.
      if (this.buffer === outgoing) this.dirty = false
      this.notice = null
      return true
    }
    return await this.#writeConflictCopy(path, outgoing)
  }

  /** §04: ref = highest existing + 1; fresh ULID; `notes/NNN-kebab-slug.md`. */
  async create(title: string): Promise<void> {
    // Refresh first so the ref is the vault's current one, not the one it had
    // when this tab was opened.
    await this.refresh()

    // The server allocates it: only the server can see `.register/trash/`, and
    // therefore only the server knows which refs have ever been handed out.
    const ref = this.nextRef
    if (ref === null) {
      this.notice = 'Vault not loaded.'
      return
    }
    const path = notePath(ref, title)

    // §04's PUT has no create-if-absent mode — without If-Match it writes
    // unconditionally — so the name has to be confirmed free before writing,
    // not inferred from the response. The tree alone is not enough: it can be a
    // refresh behind whatever an agent just created.
    if (!(await this.#isFree(path))) {
      this.notice = `${path} already exists.`
      return
    }

    try {
      const result = await putNote(path, newNote({ ref, title, now: new Date() }))
      if (!result.ok) {
        this.notice = 'That note already exists on disk.'
        return
      }
    } catch (error) {
      this.notice = describe(error)
      return
    }

    await this.refresh()
    await this.open(path)
  }

  /** Fold one vault event into the open note and the tree. */
  apply(event: VaultEvent): void {
    this.#scheduleRefresh()

    if (event.path !== this.openPath) return

    // Our own save echoing back: the server reports the etag we already hold.
    if (event.etag !== null && event.etag === this.etag) return

    if (event.type === 'removed') {
      // The file is gone; the words are not. A watcher event is something the
      // user neither initiated nor can cancel, so it must not be the thing that
      // throws away an hour of typing.
      if (this.dirty) {
        void this.#rescueRemoved(event.path)
        return
      }
      this.notice = `${event.path} was removed on disk.`
      this.openPath = null
      this.buffer = ''
      this.etag = null
      return
    }

    if (this.dirty) {
      // Do not clobber unsaved work. Latched rather than announced once, so the
      // state stays visible until the user resolves it — by saving, which takes
      // the §04 conflict path, or by reloading from disk.
      this.externalEdit = true
      return
    }
    void this.#reload(event.path)
  }

  /**
   * Discard the buffer and take what is on disk (P4's "reload from disk").
   *
   * The buffer is parked as a `*.conflict-<ts>.md` copy first. The user asked to
   * discard, but §04's doctrine is that no revision is destroyed — and the cost
   * of being wrong here is somebody's unsaved writing, against the cost of one
   * extra file they can delete.
   */
  async reloadFromDisk(): Promise<void> {
    const path = this.openPath
    if (path === null) return

    if (this.dirty) {
      const copy = await this.#park(path, this.buffer)
      if (copy === null) return
      this.notice = `Reloaded. Your version: ${basename(copy)}`
    }

    const generation = ++this.#generation
    try {
      const disk = await getNote(path)
      if (generation !== this.#generation) return
      this.#adopt(path, disk)
    } catch (error) {
      this.notice = describe(error)
    }
    this.#scheduleRefresh()
  }

  #adopt(path: string, loaded: Held): void {
    this.buffer = loaded.body
    this.etag = loaded.etag
    this.dirty = false
    this.externalEdit = false
    this.corpus[path] = loaded
  }

  async #reload(path: string): Promise<void> {
    const generation = ++this.#generation
    try {
      const loaded = await getNote(path)
      if (generation !== this.#generation || this.dirty) return
      this.#adopt(path, loaded)
    } catch {
      // The refresh that follows every event will correct the tree.
    }
  }

  /**
   * §04: on a stale etag the client "writes `*.conflict-<ts>.md` and surfaces
   * it". Nothing is discarded and nothing is merged behind the user's back —
   * both revisions exist on disk and §02b Screen 4 resolves them side by side.
   */
  async #writeConflictCopy(path: string, mine: string): Promise<boolean> {
    // Two round trips follow, and #adopt overwrites buffer and etag — so it
    // needs the same ticket every other writer takes, or a user who navigates
    // meanwhile gets this note's body under their new note's path.
    const generation = this.#generation
    const copy = await this.#park(path, mine)
    if (copy === null) return false

    let disk: Held
    try {
      disk = await getNote(path)
    } catch (error) {
      this.notice = describe(error)
      return false
    }

    // The copy is safely on disk either way; only the adoption is conditional.
    if (generation === this.#generation && this.openPath === path) {
      this.#adopt(path, disk)
      this.notice = `Changed on disk. Your version: ${basename(copy)}`
    }
    this.#scheduleRefresh()
    return true
  }

  /** Preserve a buffer whose file was deleted underneath it. */
  async #rescueRemoved(path: string): Promise<void> {
    const copy = await this.#park(path, this.buffer)
    // Nothing is cleared until the rescue is durably on disk.
    if (copy === null) return

    this.notice = `${path} was removed. Your version: ${basename(copy)}`
    this.openPath = null
    this.buffer = ''
    this.etag = null
    this.dirty = false
    this.#scheduleRefresh()
  }

  /**
   * Write `text` beside `path` as a `*.conflict-<ts>.md` copy and return its
   * name, or null if it could not be written.
   *
   * Stamped to the millisecond and probed for collisions, because §04's PUT has
   * no create-if-absent mode: an unconditional write to a name that already
   * exists replaces it. At one-second resolution two conflicts 500 ms apart —
   * one debounce interval, the pipeline's ordinary cadence — would land on the
   * same filename and §02b Screen 4's "no revision is destroyed" would be false.
   */
  async #park(path: string, text: string): Promise<string | null> {
    const base = path.replace(/\.md$/, '')
    const stamp = new Date().toISOString().replace(/[-:.]/g, '')
    // Names already parked count as taken. The tree is a refresh behind, so two
    // conflicts in quick succession would otherwise both look free, land on one
    // filename, and the second would overwrite the first.
    const taken = new Set([...this.tree.map((entry) => entry.path), ...this.#parked])

    let copy = `${base}.conflict-${stamp}.md`
    for (let nth = 2; taken.has(copy); nth++) {
      copy = `${base}.conflict-${stamp}-${nth}.md`
    }
    this.#parked.add(copy)

    try {
      await putNote(copy, text)
      return copy
    } catch (error) {
      this.#parked.delete(copy)
      this.notice = describe(error)
      return null
    }
  }

  #scheduleRefresh(): void {
    clearTimeout(this.#refreshTimer)
    this.#refreshTimer = setTimeout(() => void this.refresh(), REFRESH_COALESCE_MS)
  }

  /** Whether nothing occupies `path` on disk right now. */
  async #isFree(path: string): Promise<boolean> {
    try {
      await getNote(path)
      return false
    } catch (error) {
      // Only a genuine 404 means free. A transport failure means unknown, and
      // guessing "free" there would overwrite a note we simply could not read.
      return error instanceof ApiError && error.status === 404
    }
  }

  async #fillCorpus(): Promise<void> {
    // Bounded fan-out. `Promise.all` over the whole tree would open a request
    // per note — a thousand at once on a 1k-note vault — starving the same
    // connection pool the WebSocket and the open note are competing for.
    const queue = this.tree.filter(
      (entry) => this.corpus[entry.path]?.etag !== entry.etag,
    )
    const workers = Array.from(
      { length: Math.min(CORPUS_CONCURRENCY, queue.length) },
      async () => {
        for (let entry = queue.pop(); entry !== undefined; entry = queue.pop()) {
          try {
            this.corpus[entry.path] = await getNote(entry.path)
          } catch {
            // A note we cannot read is simply one without a word count.
          }
        }
      },
    )
    await Promise.all(workers)
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

export const vault = new VaultStore()
