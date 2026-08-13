/**
 * §02b Screen 6 — the only chrome that writes config.
 *
 * Everything here lives in `.register/config.json`, which is why it is allowed
 * to exist at all: hard rule 4 forbids state the *vault* cannot express, and
 * §04 gives config.json to "theme, fonts, flags". Nothing touches localStorage,
 * and the licensed font's bytes live in `.register/fonts/`, gitignored by
 * `register init` so they cannot leak into a public repo (§03).
 */
import { deleteFont, getConfig, getFont, putConfig, putFont } from './api'
import { DAILY_DIR } from './paths'

/** Unset means "follow the OS", which is the default and the way back. */
export type Scheme = 'system' | 'light' | 'dark'
/** §02b Screen 6: "BODY FACE [ Default·Commit ][ Teletype·Server ]". */
export type BodyFace = 'default' | 'teletype'

/**
 * §02 "Plate": the frame renders at whole multiples of the specified size.
 *
 * `'auto'` is the default and lets the canvas decide — 2× only where there is
 * room for it (tokens.css). The two pins are the way in and the way back: a
 * user on a 3440 panel who finds 2× too large needs `1` to mean *never*, not
 * "unless the window is wide", or the setting has no off.
 *
 * A closed union of two numbers and a word rather than a percentage or a
 * range. It is JSON-native, so an agent hand-editing config.json reads
 * `"scale": 2` and understands it; and it cannot express a fractional scale,
 * which on a DPR-1 panel puts Departure Mono's 11-design-pixel em on a
 * fractional device pixel and aliases the micro layer.
 */
export type Scale = 'auto' | 1 | 2

export interface Config {
  scheme: Scheme
  bodyFace: BodyFace
  scale: Scale
  /**
   * Folders the reader has collapsed in the INDEX (§02b Screen 1, Rev N).
   *
   * Full paths from the vault root, so two folders both called `archive` in
   * different places collapse independently. Stored in the vault rather than the
   * browser because hard rule 4 forbids state the vault cannot express — and
   * because the folders are a property of the vault, so the choice travelling
   * between machines is right here in a way a display scale was not.
   */
  collapsed: string[]
  /**
   * Folders the reader has opened that would otherwise start closed.
   *
   * The mirror of `collapsed`, and it exists for one folder: `daily/`. Every
   * other folder starts open, so remembering what was *shut* is enough — but a
   * journal that opened three hundred rows tall would defeat the reason it is
   * drawn at all, so that one starts shut and this remembers it was opened.
   */
  expanded: string[]
}

const DEFAULTS: Config = {
  scheme: 'system',
  bodyFace: 'default',
  scale: 'auto',
  collapsed: [],
  expanded: [],
}

/**
 * The family §03 registers a licensed face under.
 *
 * "TX-02" and nothing else: the font stack in tokens.css already names it first,
 * so a loaded face restyles the app with zero CSS changes — and a face the user
 * licensed stays under the name they licensed.
 */
const FAMILY = 'TX-02'

/** How a BYOF face is doing. §02b draws the loaded state as "◉ Loaded". */
export type FontState = 'none' | 'loading' | 'loaded' | 'error'

/**
 * Folders drawn shut until the reader says otherwise.
 *
 * One entry, and it should stay that way: this is a rule about a folder whose
 * size grows without anybody deciding to grow it.
 */
function startsClosed(path: string): boolean {
  return path === DAILY_DIR
}

class Settings {
  scheme = $state<Scheme>(DEFAULTS.scheme)
  bodyFace = $state<BodyFace>(DEFAULTS.bodyFace)
  scale = $state<Scale>(DEFAULTS.scale)
  collapsed = $state<string[]>([])
  expanded = $state<string[]>([])
  font = $state<FontState>('none')
  /** One line of instrument-voiced trouble, or nothing. */
  notice = $state<string | null>(null)

  /** True once the server has answered, so the UI never flashes a default. */
  loaded = $state(false)

  /** The face registered this session, so a reload can replace it. */
  #registered: FontFace | null = null

  /**
   * Keys in `.register/config.json` that are not this screen's to hold.
   *
   * §04 gives the file to "theme, fonts, flags" and §02b Screen 6 draws three of
   * those; `"checkpoints": true` is a flag only the server reads, set by hand or
   * by an agent, and nothing on this screen can show it. PUT replaces the whole
   * file — §05's table says so, and making it merge server-side would turn a PUT
   * into a PATCH, which is a §04 surface change — so the client has to carry
   * back what it does not understand. Without this, folding a folder in the
   * INDEX silently turned somebody's checkpoints off.
   */
  #foreign: Record<string, unknown> = {}
  /** Whether the file has actually been read. A save before it has must not
   *  write over keys it never saw. */
  #foreignKnown = false

  /**
   * Read the vault's config and register its licensed face.
   *
   * Both are best-effort. A vault whose config cannot be read is a vault with
   * default settings, not a broken app — and a font that fails to register is
   * one line in the settings pane, not a blank screen.
   */
  async start(): Promise<void> {
    try {
      const raw = await getConfig()
      const stored = asConfig(raw)
      this.scheme = stored.scheme
      this.bodyFace = stored.bodyFace
      this.scale = stored.scale
      this.collapsed = stored.collapsed
      this.expanded = stored.expanded
      this.#foreign = foreign(raw)
      this.#foreignKnown = true
    } catch {
      // Defaults already hold.
    }
    this.loaded = true
    this.apply()
    await this.loadFont()
  }

  /** Put the stored choices on the document. */
  apply(): void {
    if (typeof document === 'undefined') return
    document.documentElement.classList.toggle('teletype', this.bodyFace === 'teletype')
    // `auto` sets neither class, because auto is the classless case in
    // tokens.css: a plain media query, which therefore holds from the first
    // frame instead of waiting for this config to arrive over HTTP.
    document.documentElement.classList.toggle('scale-1', this.scale === 1)
    document.documentElement.classList.toggle('scale-2', this.scale === 2)
  }

  async setScheme(scheme: Scheme): Promise<void> {
    this.scheme = scheme
    await this.#save()
  }

  async setBodyFace(face: BodyFace): Promise<void> {
    this.bodyFace = face
    this.apply()
    await this.#save()
  }

  /**
   * Whether this folder is drawn open.
   *
   * Two lists rather than one because two folders want opposite defaults: every
   * folder you made starts open and remembers being shut, and the journal
   * starts shut and remembers being opened. A single list would have to store
   * `daily` to mean "open", which is the sort of inversion that reads as a bug
   * to anyone opening `config.json`.
   */
  isOpen(path: string): boolean {
    return startsClosed(path)
      ? this.expanded.includes(path)
      : !this.collapsed.includes(path)
  }

  /** Whether the reader has collapsed this folder. */
  isCollapsed(path: string): boolean {
    return this.collapsed.includes(path)
  }

  /**
   * Fold a folder open or shut.
   *
   * Deliberately not called when a note is opened inside a collapsed folder:
   * the sidebar reveals the open note's ancestors at render time instead, so
   * what is stored stays what the reader chose rather than drifting every time
   * ⌘K lands somewhere.
   */
  async toggleFolder(path: string): Promise<void> {
    if (startsClosed(path)) {
      this.expanded = this.expanded.includes(path)
        ? this.expanded.filter((folder) => folder !== path)
        : [...this.expanded, path]
    } else {
      this.collapsed = this.isCollapsed(path)
        ? this.collapsed.filter((folder) => folder !== path)
        : [...this.collapsed, path]
    }
    await this.#save()
  }

  async setScale(scale: Scale): Promise<void> {
    this.scale = scale
    this.apply()
    await this.#save()
  }

  /**
   * Register the stored face under "TX-02" (§03: "registered at boot via the
   * FontFace API … so the stack picks it up with zero CSS changes").
   *
   * The bytes come from this origin's own server, which is the only place they
   * exist — §08 P9: "never fetch fonts from the network".
   */
  async loadFont(): Promise<void> {
    if (typeof document === 'undefined') return
    this.font = 'loading'
    try {
      const bytes = await getFont()
      if (bytes === null) {
        this.#unregister()
        this.font = 'none'
        return
      }
      await this.#register(bytes)
      this.font = 'loaded'
      this.notice = null
    } catch (error) {
      this.font = 'error'
      this.notice = describe(error)
    }
  }

  /** Store a file the user picked, then restyle from it. */
  async useFont(file: File): Promise<void> {
    this.font = 'loading'
    this.notice = null
    try {
      const bytes = await file.arrayBuffer()
      // Stored first: the server sniffs the container and refuses anything that
      // is not a font, so a bad pick fails with a reason instead of silently
      // registering a face that draws nothing.
      await putFont(bytes)
      await this.#register(bytes)
      this.font = 'loaded'
    } catch (error) {
      this.font = 'error'
      this.notice = describe(error)
    }
  }

  /** §08 P9: "remove wipes it". */
  async clearFont(): Promise<void> {
    try {
      await deleteFont()
      this.#unregister()
      this.font = 'none'
      this.notice = null
    } catch (error) {
      this.notice = describe(error)
    }
  }

  async #register(bytes: ArrayBuffer): Promise<void> {
    this.#unregister()
    const face = new FontFace(FAMILY, bytes)
    await face.load()
    document.fonts.add(face)
    this.#registered = face
  }

  #unregister(): void {
    if (this.#registered === null) return
    document.fonts.delete(this.#registered)
    this.#registered = null
  }

  async #save(): Promise<void> {
    try {
      // A boot that could not read the file leaves us not knowing what else is
      // in it, and a write then would erase whatever that was. One read, and
      // only on the path where the answer is genuinely unknown.
      if (!this.#foreignKnown) {
        try {
          this.#foreign = foreign(await getConfig())
          this.#foreignKnown = true
        } catch {
          // Still unknown. Saving is better than a settings screen that cannot
          // write — and a config nobody can read holds nothing to preserve.
        }
      }

      // Every field, explicitly. A spread of `this` would carry the transient
      // ones (font state, notice) into the vault's config; naming them means a
      // new setting that is not added here is silently never persisted.
      //
      // The foreign keys go first so ours always win: a hand-edited `"scheme"`
      // is read at boot and becomes `this.scheme`, and letting the stale copy
      // overwrite it here would make the screen unable to change its own mind.
      await putConfig({
        ...this.#foreign,
        scheme: this.scheme,
        bodyFace: this.bodyFace,
        scale: this.scale,
        collapsed: this.collapsed,
        expanded: this.expanded,
      })
      this.notice = null
    } catch (error) {
      this.notice = describe(error)
    }
  }
}

/**
 * The keys of a config document this screen does not own.
 *
 * The complement of `asConfig`: that one answers "what may I read", this one
 * answers "what must I put back". Values are returned untouched — an unknown key
 * is unknown all the way down, so re-serialising it is the most that can be
 * done honestly with it.
 */
export function foreign(value: unknown): Record<string, unknown> {
  // An array is an object to `typeof`, and iterating one here would put `{"0":
  // …}` into the vault's config file rather than preserving anything.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const kept: Record<string, unknown> = {}
  for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
    if (!OURS.has(key)) kept[key] = held
  }
  return kept
}

/** The keys §02b Screen 6 draws, and therefore the only ones it may replace. */
const OURS = new Set<string>([
  'scheme',
  'bodyFace',
  'scale',
  'collapsed',
  'expanded',
] satisfies (keyof Config)[])

/** Read a config document without trusting its shape. */
export function asConfig(value: unknown): Config {
  if (typeof value !== 'object' || value === null) return { ...DEFAULTS }
  const record = value as Record<string, unknown>

  return {
    scheme: isScheme(record.scheme) ? record.scheme : DEFAULTS.scheme,
    bodyFace: isBodyFace(record.bodyFace) ? record.bodyFace : DEFAULTS.bodyFace,
    scale: isScale(record.scale) ? record.scale : DEFAULTS.scale,
    collapsed: asFolders(record.collapsed),
    expanded: asFolders(record.expanded),
  }
}

function isScheme(value: unknown): value is Scheme {
  return value === 'system' || value === 'light' || value === 'dark'
}

function isBodyFace(value: unknown): value is BodyFace {
  return value === 'default' || value === 'teletype'
}

/**
 * Identity against a closed set, which is the whole defence.
 *
 * `1.5`, `0`, `3`, `-1`, `NaN`, `Infinity`, `'2'` and `null` are all false here
 * without a single range check — and they have to be, because the server treats
 * config.json as opaque JSON (it validates that it parses, nothing more), so
 * this function is the only thing between a hand-edited file and the frame.
 */
function isScale(value: unknown): value is Scale {
  return value === 'auto' || value === 1 || value === 2
}

/**
 * A list of folder paths from a file anyone can hand-edit.
 *
 * Anything that is not a non-empty string is dropped rather than the whole list
 * being discarded: one bad entry should cost one folder's fold state, not the
 * reader's whole tree.
 */
function asFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry !== '',
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const settings = new Settings()
