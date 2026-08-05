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

/** Unset means "follow the OS", which is the default and the way back. */
export type Scheme = 'system' | 'light' | 'dark'
/** §02b Screen 6: "BODY FACE [ Default·Commit ][ Teletype·Server ]". */
export type BodyFace = 'default' | 'teletype'

export interface Config {
  scheme: Scheme
  bodyFace: BodyFace
}

const DEFAULTS: Config = { scheme: 'system', bodyFace: 'default' }

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

class Settings {
  scheme = $state<Scheme>(DEFAULTS.scheme)
  bodyFace = $state<BodyFace>(DEFAULTS.bodyFace)
  font = $state<FontState>('none')
  /** One line of instrument-voiced trouble, or nothing. */
  notice = $state<string | null>(null)

  /** True once the server has answered, so the UI never flashes a default. */
  loaded = $state(false)

  /** The face registered this session, so a reload can replace it. */
  #registered: FontFace | null = null

  /**
   * Read the vault's config and register its licensed face.
   *
   * Both are best-effort. A vault whose config cannot be read is a vault with
   * default settings, not a broken app — and a font that fails to register is
   * one line in the settings pane, not a blank screen.
   */
  async start(): Promise<void> {
    try {
      const stored = asConfig(await getConfig())
      this.scheme = stored.scheme
      this.bodyFace = stored.bodyFace
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
      await putConfig({ scheme: this.scheme, bodyFace: this.bodyFace })
      this.notice = null
    } catch (error) {
      this.notice = describe(error)
    }
  }
}

/** Read a config document without trusting its shape. */
export function asConfig(value: unknown): Config {
  if (typeof value !== 'object' || value === null) return { ...DEFAULTS }
  const record = value as Record<string, unknown>

  return {
    scheme: isScheme(record.scheme) ? record.scheme : DEFAULTS.scheme,
    bodyFace: isBodyFace(record.bodyFace) ? record.bodyFace : DEFAULTS.bodyFace,
  }
}

function isScheme(value: unknown): value is Scheme {
  return value === 'system' || value === 'light' || value === 'dark'
}

function isBodyFace(value: unknown): value is BodyFace {
  return value === 'default' || value === 'teletype'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const settings = new Settings()
