import { setWatcherRender } from '../lib/render.svelte'
import { isoStamp } from '../lib/time'
import {
  ApiError,
  deleteFolder,
  deleteNote,
  type Entry,
  type GitStatus,
  getLedger,
  getNote,
  getTree,
  type Loaded,
  type Moved,
  movePath,
  openEvents,
  putNote,
  type Trashed,
  type VaultEvent,
  VaultMoved,
  type Version,
} from './api'
import { type Conflict, conflicts, originalOf } from './conflict'
import { charCount, setField, touchModified, wordCount } from './frontmatter'
import { outsideSince } from './ledger'
import { NoteLookup } from './links'
import { apply, moved as movedPath, rewrites } from './move'
import { offline } from './offline'
import { basename, cleanFolder, DAILY_TEMPLATE, inside, isListed } from './paths'
import { dailyFrom, dailyPath, noteFrom, notePath } from './refs'
import { toggle } from './tasks'

/**
 * What a deletion did: it happened, it failed, or the vault moved first.
 *
 * `'moved'` is not a failure. §04 Rev X guards a deletion with the tree's
 * revision, so a note an agent edited between the confirm being drawn and
 * answered refuses rather than being trashed carrying an edit the reader was
 * never shown — and the answer to that is to ask again about what is there now,
 * which only the surface that drew the question can do.
 */
export type Trashing = boolean | 'moved'

/**
 * The two §04 fields nothing in the UI may rewrite.
 *
 * "id: ULID, never changes" and "ref: zero-padded, immutable" — and the ref is
 * load-bearing beyond the note itself: `[[NNN]]` resolves by it, and §04's
 * invariant is that a ref is issued at most once so a link can never be
 * re-pointed by a delete-then-create.
 */
const IMMUTABLE = new Set(['id', 'ref'])

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

/**
 * Parallel body fetches when filling the corpus.
 *
 * Three, not eight. A browser opens at most six connections per origin, so a
 * fill that takes eight leaves none — and every request the *user* makes queues
 * behind a thousand background reads. Measured on a 1k-note vault: it put start
 * → editable at 566 ms against §06's 500, a document switch at 272 ms, and an
 * agent edit at 158 ms against a 100 ms budget, all while the app's own RENDER
 * readout stayed under 16 ms. Nothing was slow; everything was waiting.
 */
const CORPUS_CONCURRENCY = 3

/**
 * Coalesce tree refreshes across one burst of events without adding latency.
 * The server already batches at 50 ms and §06 budgets 100 ms from an agent's
 * write to the repaint, so there is no room for a second real delay here — a
 * zero-delay timer only merges events that arrive in the same tick.
 */
const REFRESH_COALESCE_MS = 0

/**
 * What asking the server about a name told us.
 *
 * Three answers, not two: "free", "somebody has it", and "the server will not
 * have it at all" — which used to collapse into the second and print
 * "already exists" over a path that never could have.
 */
type Vacancy = { state: 'free' } | { state: 'taken' } | { state: 'refused'; why: string }

class VaultStore {
  /** Every note, from `/api/tree`. The sidebar's only source. */
  tree = $state<Entry[]>([])
  /** Note bodies, filled in behind the tree so the sidebar paints first. */
  corpus = $state<Record<string, Loaded>>({})

  openPath = $state<string | null>(null)
  buffer = $state('')
  etag = $state<string | null>(null)
  dirty = $state(false)

  /** Where the vault lives, for the status bar. Reported by the server (§04). */
  vaultPath = $state<string | null>(null)
  /** The ref a new note must take. The server owns it: only it sees the trash. */
  nextRef = $state<string | null>(null)
  /**
   * The vault's revision, and what a deletion is guarded by (§04 Rev X).
   *
   * Null until the first tree lands, which is why a confirm armed before that
   * goes unguarded rather than refusing — there is nothing to compare and
   * nothing has been drawn to confirm against either.
   */
  rev = $state<number | null>(null)
  /** The vault's git state, or null when it is not a repository (§08 P12). */
  git = $state<GitStatus | null>(null)

  /**
   * What landed outside the app since you last wrote to it (§02b Screen 11).
   *
   * Read from the ledger at boot and whenever a checkpoint says history moved;
   * emptied by a save through the app, because that save is then the newest
   * word and the next checkpoint will say so. Derived, never stored — see
   * `outsideSince` for what "outside" means.
   */
  outside = $state<Version[]>([])

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
  #toggling: Promise<boolean> | null = null
  #dirtySince = 0
  #refreshTicket = 0
  #stopped = false
  #saveTimer: ReturnType<typeof setTimeout> | undefined
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #disconnect: (() => void) | undefined
  /** Guards against a slow fetch landing after the user moved on. */
  #generation = 0

  /**
   * When the current burst of watcher events arrived, and what the vault held
   * before it (§02b Screen 7).
   *
   * The *first* frame of a burst, not the last: the server already batches at
   * 50 ms and the refresh that follows covers all of them, so one repaint
   * answers the lot and the honest clock starts when the first one landed.
   */
  #watcherAt: number | null = null
  #watcherFiles = 0

  /**
   * Link resolution, rebuilt only when the tree is replaced.
   *
   * The editor asks `exists()` for every visible wikilink on every keystroke, so
   * a linear scan per link is a per-keystroke cost proportional to the corpus.
   */
  #lookup = $derived(new NoteLookup(this.tree))

  /**
   * How many notes the vault holds, as the INDEX and the status bar count them.
   *
   * Not `tree.length`: the tree carries the agent contract and the stencils too,
   * and a sidebar listing eight rows above a status bar claiming ten files is
   * the app disagreeing with itself about what a note is.
   */
  get files(): number {
    return this.tree.filter((entry) => isListed(entry.path)).length
  }

  get active(): Entry | null {
    return this.tree.find((entry) => entry.path === this.openPath) ?? null
  }

  /**
   * Resolve a `[[wikilink]]` by title or ref — §04 allows either.
   *
   * One definition, in `links.ts`, shared with the backlink graph: a link the
   * editor follows and a link the inspector counts must mean the same thing.
   */
  resolve(target: string): Entry | null {
    return this.#lookup.find(target)
  }

  /**
   * Open today's daily log, creating it from `templates/daily.md` if there is
   * one (§08 P7).
   *
   * Idempotent twice over: the name is the date, so a second call the same day
   * finds the note rather than making another — and the name is confirmed free
   * on disk before writing, because the tree can be a refresh behind an agent.
   */
  async openDaily(now: Date = new Date()): Promise<void> {
    const path = dailyPath(now)
    await this.refresh()

    if (!this.tree.some((entry) => entry.path === path)) {
      // Said in the extract's own terms rather than left to the write to refuse:
      // the reader asked for a day, and the answer is about the day.
      if (offline) {
        this.notice = `No log for ${path.slice(6, 16)} in this extract.`
        return
      }
      // Anything but `free` means do not write: taken is today's log, already
      // there, and refused means we could not find out — and guessing free
      // would put the stencil straight over whatever is on disk.
      //
      // Spelled against the state rather than as `!isFree(...)`, which is how
      // this read before the answer grew a third case. `!` on an object is
      // always false and is not a type error, so that spelling compiled, always
      // took the create branch, and would have overwritten a real daily log.
      if ((await this.#isFree(path)).state !== 'free') {
        await this.open(path)
        return
      }

      const template = await this.#template(DAILY_TEMPLATE)
      // A template that exists but cannot be read stops the creation. Writing
      // the day's note from the wrong stencil is not something the user can
      // undo by pressing the key again — the note would already be there.
      if (!template.ok) return

      try {
        await putNote(path, dailyFrom(template.body, now))
      } catch (error) {
        this.notice = describe(error)
        return
      }
      await this.refresh()
    }
    await this.open(path)
  }

  /**
   * A template's text, `null` when there is none.
   *
   * Read from disk rather than from the corpus: this runs once a day, and a
   * stencil the user just edited should be the one the note is cut from.
   */
  async #template(
    path: string,
  ): Promise<{ ok: true; body: string | null } | { ok: false }> {
    try {
      return { ok: true, body: (await getNote(path)).body }
    } catch (error) {
      // Absent is not a failure — §04 makes templates optional.
      if (error instanceof ApiError && error.status === 404) {
        return { ok: true, body: null }
      }
      this.notice = describe(error)
      return { ok: false }
    }
  }

  /** Follow a wikilink, creating the note if it does not exist (§02b). */
  async follow(target: string): Promise<void> {
    const found = this.resolve(target)
    if (found !== null) {
      await this.open(found.path)
      return
    }
    // The link's other half of the promise — a missing target is created — is
    // a write, and an extract makes none. The dotted mark already says the note
    // is not here; this says it in words when the mark is followed anyway.
    if (offline) {
      this.notice = `No note called ${target.trim()} in this extract.`
      return
    }
    await this.create(target.trim())
  }

  /** Live word count of the open buffer, for §02b Screen 1's meta strip. */
  get openWords(): number | null {
    return this.openPath === null ? null : wordCount(this.buffer)
  }

  /** And its characters, which P4 asks for in the same breath as its words. */
  get openChars(): number | null {
    return this.openPath === null ? null : charCount(this.buffer)
  }

  /** Words in a note, or null until its body has loaded. */
  words(path: string): number | null {
    const held = this.corpus[path]
    return held ? wordCount(held.body) : null
  }

  /**
   * Every unresolved conflict in the vault (§02b Screen 4).
   *
   * Derived from the tree, not remembered from the moment the conflict happened.
   * `notice` is cleared by the very next save, and `#writeConflictCopy` skips it
   * entirely when the user has navigated away — so the announcement has to come
   * from the thing that persists, which is the file.
   */
  get unresolved(): Conflict[] {
    return this.#unresolved
  }

  /**
   * Memoised, because `enabled()` runs per command per keystroke.
   *
   * `matchCommands` calls every command's `enabled` and `Palette.svelte` re-runs
   * it on each key, so a plain getter rebuilt a Map over the whole tree, filtered
   * and sorted it, once per keypress — against §06's 16 ms interaction budget, on
   * a vault that can hold a thousand notes. `$derived` recomputes when `tree`
   * moves, which is the only thing that can change the answer.
   */
  #unresolved = $derived(conflicts(this.tree))

  async start(): Promise<void> {
    this.#stopped = false
    await this.refresh()
    // Behind the tree, not before it: the ledger is a `git log` on the server,
    // and the first paint must not wait for one.
    void this.refreshLedger()
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
      this.git = tree.git
      this.rev = tree.rev
    } catch (error) {
      this.notice = describe(error)
      return
    }
    // The tree is installed, so FILES and the INDEX have moved: if a watcher
    // event asked for this refresh, that is the repaint it was waiting for.
    this.#settleWatcher()
    void this.#fillCorpus()
  }

  async open(path: string): Promise<void> {
    // A failed save leaves the only copy of the user's text in the buffer we
    // are about to replace, so a refused save refuses the navigation too.
    if (this.dirty && !(await this.save())) return

    const generation = ++this.#generation
    let loaded: Loaded
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
    // The editor is read-only in an extract, so this is never reached from a
    // keystroke. It is still the one door every edit comes through — the
    // PROPERTIES pane included — and the store, not the surface, is what
    // promises the buffer never diverges from the file it was cut from.
    if (offline) return
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
   * Write one frontmatter field of the open note (§02b Screen 1, PROPERTIES).
   *
   * The editor hides §04's frontmatter, so this pane is where those lines are
   * edited — and it goes through the same buffer and the same debounced save a
   * keystroke does, rather than writing a file of its own. `setField` splices
   * one line, so key order, quoting, comments and every other byte survive.
   *
   * `id` and `ref` are refused rather than merely undrawn: §04 calls both
   * immutable, a `[[NNN]]` link resolves by ref, and a pane that edited them
   * would let one keystroke unpick the register. The UI does not offer them; a
   * caller that asks anyway is a bug, and this is where it stops.
   */
  setNoteField(key: string, value: string): void {
    if (this.openPath === null || IMMUTABLE.has(key)) return
    const next = setField(this.buffer, key, value)
    if (next !== this.buffer) this.edit(next)
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
      // A save through the app is the newest word: everything the ledger
      // counted as "since your last save" is now before it.
      this.outside = []
      this.notice = null
      return true
    }
    return await this.#writeConflictCopy(path, outgoing)
  }

  /**
   * §04: ref allocated by the server; fresh ULID; `notes/NNN-kebab-slug.md`.
   *
   * `from` names a note under `templates/` to cut it from (§08 P7). One creation
   * path either way, so the free-name guard and the ref allocation cannot drift
   * between a blank note and a templated one.
   */
  async create(
    title: string,
    from?: string,
    folder?: string,
    retry = true,
  ): Promise<void> {
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
    // A folder the INDEX cannot draw is refused rather than written into: a note
    // in `daily/` or `templates/` is `isListed`-hidden, so creating one there
    // succeeds and then appears to have done nothing. `folderTargets` never
    // offers those, but a typed path can name anything — and the check has to
    // run per segment, before the filesystem or the URL parser rewrites it.
    // `cleanFolder` carries the two measurements that prove why.
    let target: string | undefined
    if (folder !== undefined) {
      const clean = cleanFolder(folder)
      if (clean === null) {
        this.notice = `${folder} is not a folder notes can go in.`
        return
      }
      target = clean
    }
    const path = notePath(ref, title, target)

    // §04's PUT has no create-if-absent mode — without If-Match it writes
    // unconditionally — so the name has to be confirmed free before writing,
    // not inferred from the response. The tree alone is not enough: it can be a
    // refresh behind whatever an agent just created.
    const vacancy = await this.#isFree(path)
    if (vacancy.state === 'taken') {
      this.notice = `${path} already exists.`
      return
    }
    if (vacancy.state === 'refused') {
      // Not "already exists". A path the server will not accept never could
      // have existed, and saying it did sends the reader looking for a file.
      this.notice = `${path}: ${vacancy.why}`
      return
    }

    let template: string | null = null
    if (from !== undefined) {
      const read = await this.#template(from)
      if (!read.ok) return
      if (read.body === null) {
        this.notice = `${from} is gone.`
        return
      }
      template = read.body
    }

    try {
      const body = noteFrom(template, { ref, title, now: new Date() })
      const result = await putNote(path, body)
      if (!result.ok) {
        // Two tabs that read the tree in the same instant are handed the same
        // `nextRef`, and because they usually type different titles the paths
        // differ — so the free-name check above passes for both. The server
        // refuses the second, because §04 allocates a ref once and never
        // reissues it. Losing that race is not an error to report: refetch and
        // take the next one, exactly as this would have done a moment later.
        //
        // Once. A second failure is something other than a lost race, and a
        // client that retried forever would be worse than one that gave up.
        if (retry) {
          await this.refresh()
          await this.create(title, from, folder, false)
          return
        }
        this.notice = 'That note already exists on disk.'
        return
      }
      // What we just left on disk, recorded here rather than waited for from
      // `#fillCorpus`. The event this write causes arrives before that fetch
      // does, and without the etag to recognise it by, making a note from the
      // palette announced itself in the status bar as an agent's (§02b Screen
      // 7). It also saves the fetch.
      this.corpus[path] = { body, etag: result.etag }
    } catch (error) {
      this.notice = describe(error)
      return
    }

    await this.refresh()
    // The path the *server* wrote, not the string that was typed. A filesystem
    // that folds case or unicode writes a different one, and `openPath` is
    // compared by string in three places — the active INDEX row, the folder
    // reveal, and the external-edit latch — every one of which silently stops
    // matching for the note just made. The ref is the join: the server
    // allocated it, and nothing else in the vault carries it.
    const written = this.tree.find((entry) => entry.ref === ref)
    await this.open(written?.path ?? path)
  }

  /**
   * Flip one task's box, writing through to the file it lives in (§08 P7).
   *
   * Returns whether the vault now holds the change.
   */
  async toggleTask(path: string, at: number): Promise<boolean> {
    // Serialised, because two clicks in a row both read the same corpus body and
    // the second would send an etag the first has already superseded — a 409 for
    // an edit that was never in conflict with anything but itself.
    while (this.#toggling !== null) await this.#toggling

    this.#toggling = this.#toggleOnce(path, at)
    try {
      return await this.#toggling
    } finally {
      this.#toggling = null
    }
  }

  async #toggleOnce(path: string, at: number): Promise<boolean> {
    // The open note is edited through the buffer, never through the file. It may
    // hold unsaved text, and a write underneath it would either be overwritten
    // by the next debounced save or manufacture a conflict copy of the note
    // against itself.
    if (path === this.openPath) {
      const next = toggle(this.buffer, at)
      if (next === null) {
        this.notice = 'That task moved. Nothing toggled.'
        return false
      }
      this.edit(next)
      return true
    }

    const held = this.corpus[path]
    if (held === undefined) {
      this.notice = `${path} is not loaded.`
      return false
    }

    const next = toggle(held.body, at)
    if (next === null) {
      this.notice = `${basename(path)} changed. Nothing toggled.`
      this.#scheduleRefresh()
      return false
    }

    const outgoing = touchModified(next, isoStamp())
    let result: Awaited<ReturnType<typeof putNote>>
    try {
      result = await putNote(path, outgoing, held.etag)
    } catch (error) {
      this.notice = describe(error)
      return false
    }

    if (!result.ok) {
      // No conflict copy, and nothing to park: the user typed nothing here, so
      // the whole cost of refusing is that a box stayed as it was.
      this.notice = `${basename(path)} changed on disk. Nothing toggled.`
      this.#scheduleRefresh()
      return false
    }

    this.corpus[path] = { body: outgoing, etag: result.etag }
    return true
  }

  /** Fold one vault event into the open note and the tree. */
  apply(event: VaultEvent): void {
    // History moved, not the vault: a checkpoint committed. Nothing on disk
    // changed, so nothing here does — except what the ledger says.
    if (event.type === 'checkpoint') {
      void this.refreshLedger()
      return
    }

    // Our own write echoing back: the server reports an etag we already hold.
    // Tested before the clock starts, because §02b Screen 7's readout is about
    // somebody *else* writing to the vault — timing our own PUT round trip and
    // labelling it WATCHER would be the fabricated gauge the section retires.
    const ours = this.#isEcho(event)
    if (!ours && this.#watcherAt === null) {
      this.#watcherAt = performance.now()
      this.#watcherFiles = this.files
    }

    // The open note first, the tree second. Both are wanted, but only one is on
    // screen — and issuing the tree fetch first puts a walk of the whole vault
    // ahead of the single note the reader is looking at.
    if (event.path !== this.openPath) {
      this.#scheduleRefresh()
      return
    }

    // Deliberately *not* returning here for our own echo when the buffer is
    // clean. §04 states the rule the cheap etag depends on: a client receiving a
    // `changed` frame must reload the note even when the tag it holds is equal,
    // because `mtime + len` collides for two bodies of identical length written
    // inside one filesystem tick — unreachable on APFS, reachable on the ext4
    // under a Linux container. Treating an equal tag as "nothing happened" is
    // the one way that collision loses somebody's writing rather than merely
    // being untidy, and it is what this branch used to do.
    //
    // The cost is one GET of the open note after our own save. Small, bounded by
    // the debounce, and paid on the file the reader is actually looking at.
    // `ours` still gates the *timing* readout above, which is a different
    // question and is safe to answer from the tag.
    if (ours && this.dirty) {
      this.#scheduleRefresh()
      return
    }

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
      this.#scheduleRefresh()
      return
    }

    if (this.dirty) {
      // Do not clobber unsaved work. Latched rather than announced once, so the
      // state stays visible until the user resolves it — by saving, which takes
      // the §04 conflict path, or by reloading from disk.
      this.externalEdit = true
      this.#scheduleRefresh()
      return
    }
    void this.#reload(event.path)
    this.#scheduleRefresh()
  }

  /**
   * Whether this event is the vault repeating something we just wrote.
   *
   * The open note's etag is not enough on its own: a task toggled in TODAY, a
   * note created from the palette and a parked conflict copy are all writes to
   * a path that is not open, and every one of them comes back as an event. Read
   * off the corpus, which is where a successful write records what it left on
   * disk — so "ours" means "the vault holds exactly what we last put there".
   */
  #isEcho(event: VaultEvent): boolean {
    if (event.etag === null) return false
    if (event.path === this.openPath && event.etag === this.etag) return true
    return this.corpus[event.path]?.etag === event.etag
  }

  /**
   * Close the watcher's round trip, if one is open (§02b Screen 7).
   *
   * Called from both paths a watcher event can repaint through — the tree, and
   * the open note's body — because either can be the one on screen and the
   * first to land is the one the reader saw. Clearing the stamp is what makes
   * it first-one-wins.
   */
  #settleWatcher(): void {
    const at = this.#watcherAt
    if (at === null) return
    this.#watcherAt = null
    setWatcherRender(at, this.files - this.#watcherFiles)
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

  /**
   * Rename or move a note or a folder, rewriting what stops resolving.
   *
   * §04 Rev Y. The order is the safety property, and it is the same one
   * `resolveConflict` takes: the **move first**, then the rewrites. A failure
   * between them leaves every file on disk and some references stale, which is
   * visible and fixable; the other order edits notes to point at a move that
   * then does not happen, which is neither.
   *
   * Rewriting is narrow by construction. `[[wikilinks]]` resolve by ref or title
   * and survive untouched, so `move.ts` only ever re-points relative
   * `![](src)` — and moving a folder whole usually rewrites nothing, because
   * the images travel with the notes.
   */
  async move(from: string, to: string): Promise<boolean> {
    // Worked out before the move, against the corpus as it stands: afterwards
    // the paths have changed and the question cannot be asked the same way.
    const changes = rewrites(this.corpus, from, to)

    let result: Moved
    try {
      result = await movePath(from, to)
    } catch (error) {
      this.notice = describe(error)
      return false
    }

    // The corpus follows the files, so a rewrite lands on the note's new path.
    for (const [path, held] of Object.entries(this.corpus)) {
      const after = movedPath(path, from, to)
      if (after === null) continue
      delete this.corpus[path]
      this.corpus[after] = held
    }

    let rewritten = 0
    for (const path of new Set(changes.map((one) => one.note))) {
      const held = this.corpus[path]
      if (held === undefined) continue
      const body = apply(
        held.body,
        changes.filter((one) => one.note === path),
      )
      if (body === held.body) continue
      // Through the ordinary guarded write, so a note an agent touched in the
      // meantime takes the §04 conflict path rather than being overwritten.
      const saved = await this.#repoint(path, body, held.etag)
      if (saved) rewritten += 1
    }

    const moved =
      result.notes === 0
        ? basename(to)
        : `${result.notes} note${result.notes === 1 ? '' : 's'}`
    this.notice =
      rewritten === 0
        ? `Moved ${moved} to ${to}.`
        : `Moved ${moved} to ${to}; repointed ${rewritten} note${rewritten === 1 ? '' : 's'}.`

    await this.refresh()
    if (this.openPath !== null) {
      const after = movedPath(this.openPath, from, to)
      if (after !== null) await this.open(after)
    }
    return true
  }

  /**
   * Write a body over a note we already hold the etag for.
   *
   * The rewrite path's only writer, and named apart from `#writeOnce` because it
   * writes a *given* body rather than the open buffer. Guarded, so a note an
   * agent edited between the move being planned and the rewrite landing takes
   * §04's conflict route instead of being flattened.
   */
  async #repoint(path: string, body: string, etag: string): Promise<boolean> {
    try {
      const result = await putNote(path, body, etag)
      if (!result.ok) return false
      this.corpus[path] = { body, etag: result.etag }
      return true
    } catch {
      return false
    }
  }

  /**
   * Move one note to the trash (§04 Rev P).
   *
   * A dirty buffer is **not** saved first, unlike every other navigation: the
   * point of the operation is that this text is not wanted, and writing it to
   * disk on the way to deleting it is work whose only effect is a larger file in
   * the trash.
   */
  async trashNote(path: string, rev?: number): Promise<Trashing> {
    try {
      await deleteNote(path, rev)
    } catch (error) {
      // Not a failure to report: the vault moved under the question, so the
      // question has to be put again. §04 Rev X, and the caller re-arms.
      if (error instanceof VaultMoved) return 'moved'
      this.notice = describe(error)
      return false
    }
    this.#forget(path)
    // Where it went, because §04 never hard-deletes and a message that does not
    // say where to look makes a recoverable operation feel final.
    this.notice = `Trashed ${basename(path)} → .register/trash/`
    await this.#refreshUntilGone((held) => held === path)
    return true
  }

  /**
   * Move a folder and everything under it to the trash (§04 Rev P).
   *
   * The notice reports the server's counts rather than the one the confirm was
   * built from. They differ by exactly what the INDEX cannot draw — media above
   * all — and a folder that took an image with it should say so rather than let
   * the reader find out in Finder.
   */
  async trashFolder(path: string, rev?: number): Promise<Trashing> {
    let moved: Trashed
    try {
      moved = await deleteFolder(path, rev)
    } catch (error) {
      if (error instanceof VaultMoved) return 'moved'
      this.notice = describe(error)
      return false
    }

    for (const held of Object.keys(this.corpus)) {
      if (inside(held, path)) this.#forget(held)
    }
    this.notice = `Trashed ${path} — ${count(moved.notes, 'note')}${
      moved.files === 0 ? '' : ` and ${count(moved.files, 'file')}`
    } → ${moved.bucket}`
    await this.#refreshUntilGone((held) => inside(held, path))
    return true
  }

  /**
   * Refresh until the tree stops listing what was just deleted.
   *
   * `refresh` abandons its result when a newer refresh supersedes it, and
   * deleting a file makes the *watcher* fire one — so ours can lose the race and
   * return having installed nothing, leaving the tree still listing a note that
   * is gone. Reporting success there makes the store's promise mean less than
   * callers read it as: the UI then places focus against a row the next refresh
   * destroys, and focus falls to <body>.
   *
   * Measured, twice, as one e2e failure on a two-vCPU runner that no local run
   * reproduced. Bounded rather than looped until true: two attempts settle the
   * race this closes, and a tree that still disagrees after that is a bug worth
   * seeing rather than one worth spinning on.
   */
  async #refreshUntilGone(deleted: (path: string) => boolean): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.refresh()
      if (!this.tree.some((entry) => deleted(entry.path))) return
    }
  }

  /**
   * Drop everything held about a path that is no longer on disk.
   *
   * The corpus matters as much as the buffer: nothing else prunes it —
   * `#fillCorpus` only ever adds — so a trashed note would keep answering ⌘K
   * with a body the vault no longer has.
   */
  #forget(path: string): void {
    delete this.corpus[path]
    this.#parked.delete(path)
    if (this.openPath !== path) return
    // A pending save would otherwise write the buffer straight back to the path
    // that was just emptied, resurrecting the note as a side effect of deleting
    // it. Cleared before the flags so the debounce has nothing left to aim at.
    clearTimeout(this.#saveTimer)
    this.openPath = null
    this.buffer = ''
    this.etag = null
    this.dirty = false
    this.externalEdit = false
  }

  /**
   * Write a merged note over the original and retire the copy (§02b Screen 4).
   *
   * Returns whether the vault now holds the merge. The order is the whole
   * safety property: the merge is durable *before* the copy is deleted, so a
   * failure between the two leaves both revisions on disk. The other order
   * leaves neither, and "no revision is destroyed" is the frame's own promise.
   */
  async resolveConflict(copy: string, merged: string): Promise<boolean> {
    const path = originalOf(copy)
    if (path === null) {
      this.notice = `${basename(copy)} is not a conflict copy.`
      return false
    }

    // Same rule as #writeOnce: without If-Match, §04's PUT writes
    // unconditionally, so a note we never read must not be written. A note that
    // is not in the tree is the exception — there the copy is the only surviving
    // revision, and the merge is a create.
    const etag = this.corpus[path]?.etag
    if (etag === undefined && this.tree.some((entry) => entry.path === path)) {
      this.notice = `${basename(path)} is not loaded. Refusing to overwrite it.`
      return false
    }

    let result: Awaited<ReturnType<typeof putNote>>
    try {
      result = await putNote(path, merged, etag)
    } catch (error) {
      this.notice = describe(error)
      return false
    }
    if (!result.ok) {
      // The original moved again while the merge was being chosen. Nothing is
      // lost — both files are still there — but the table the user read it from
      // is stale, so it has to be rebuilt rather than written over.
      this.notice = `${basename(path)} changed again. Nothing merged.`
      await this.refresh()
      return false
    }

    const written: Loaded = { body: merged, etag: result.etag }
    this.corpus[path] = written
    if (this.openPath === path) this.#adopt(path, written)

    try {
      await deleteNote(copy)
    } catch (error) {
      // The merge is on disk; only the cleanup failed. Say both halves, because
      // "merged" alone would leave a copy in the list with nothing explaining it.
      this.notice = `Merged into ${basename(path)}. ${basename(copy)} remains: ${describe(error)}`
      await this.refresh()
      return true
    }

    // The ledger `#park` maintains has to hear about this too: it exists so two
    // conflicts in the same millisecond cannot pick one filename, and a name
    // that is no longer on disk should stop reserving itself.
    this.#parked.delete(copy)

    // The copy is gone, so a buffer still bound to it has nothing behind it.
    if (this.openPath === copy) {
      this.openPath = null
      this.buffer = ''
      this.etag = null
      this.dirty = false
      this.externalEdit = false
    }
    this.notice = `Merged into ${basename(path)}.`
    await this.refresh()
    return true
  }

  /**
   * Ask the ledger what landed outside the app since the last save.
   *
   * Quiet on failure: a vault without history answers `[]`, and a vault whose
   * git cannot answer is a line in the server's log, not a notice over the
   * note somebody is reading.
   */
  async refreshLedger(): Promise<void> {
    try {
      this.outside = outsideSince(await getLedger())
    } catch {
      // Nothing true to say; the count stays what it was.
    }
  }

  /**
   * Put an earlier version of a note back (§02b Screen 11).
   *
   * Through the same guarded PUT as any save: a note that moved since the
   * version was read is a 409 and nothing is overwritten. `modified` is
   * stamped, because the app wrote the file now; everything else goes back
   * byte for byte. Refused while the note is open with unsaved text — a
   * restore is not what should decide what happens to an hour of typing.
   *
   * Returns whether the vault now holds the version.
   */
  async restore(path: string, body: string): Promise<boolean> {
    if (this.openPath === path && this.dirty) {
      this.notice = `${basename(path)} has unsaved text. Save or reload it first.`
      return false
    }
    // Same rule as #writeOnce: without If-Match, §04's PUT writes
    // unconditionally, so a note we never read must not be written over. A
    // note that is not in the tree is the exception — it was removed, and the
    // restore is a create.
    const etag = this.corpus[path]?.etag
    if (etag === undefined && this.tree.some((entry) => entry.path === path)) {
      this.notice = `${basename(path)} is not loaded. Refusing to overwrite it.`
      return false
    }

    const outgoing = touchModified(body, isoStamp())
    let result: Awaited<ReturnType<typeof putNote>>
    try {
      result = await putNote(path, outgoing, etag)
    } catch (error) {
      this.notice = describe(error)
      return false
    }
    if (!result.ok) {
      this.notice = `${basename(path)} changed again. Nothing restored.`
      await this.refresh()
      return false
    }

    const written: Loaded = { body: outgoing, etag: result.etag }
    this.corpus[path] = written
    if (this.openPath === path) this.#adopt(path, written)
    this.outside = []
    this.notice = `Restored ${basename(path)}.`
    await this.refresh()
    return true
  }

  #adopt(path: string, loaded: Loaded): void {
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
      // The open note is the row §02b Screen 7 says is "painted in place", and
      // on an edit to a note that already exists it moves before the tree does.
      this.#settleWatcher()
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

    let disk: Loaded
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
      const result = await putNote(copy, text)
      // Same reason `create` records its own: a copy we parked is not an agent
      // writing to the vault, and the status bar must not say it was.
      if (result.ok) this.corpus[copy] = { body: text, etag: result.etag }
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
  async #isFree(path: string): Promise<Vacancy> {
    try {
      await getNote(path)
      return { state: 'taken' }
    } catch (error) {
      // Only a genuine 404 means free. A transport failure means unknown, and
      // guessing "free" there would overwrite a note we simply could not read.
      if (error instanceof ApiError && error.status === 404) return { state: 'free' }
      // Distinct from taken, because the caller says different things about
      // them: a path the server refuses is not a name somebody else has.
      return { state: 'refused', why: describe(error) }
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

/**
 * "1 note" / "2 notes" — the plural that would otherwise read as a bug.
 *
 * A notice saying "1 notes" is the kind of thing that makes a reader distrust
 * the number beside it, which is the one thing this message exists to carry.
 */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const vault = new VaultStore()
