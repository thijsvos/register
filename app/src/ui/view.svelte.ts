import { settings } from '../core/settings.svelte'
import { measure } from '../lib/render.svelte'

/**
 * Chrome state: what is on screen, as opposed to what is in the vault.
 *
 * In memory only, and that is the rule: hard rule 4 forbids state the vault
 * cannot express, and which pane you last looked at is not knowledge.
 *
 * The colour scheme is the exception, and it is not one — §02b Screen 6 stores
 * it in `.register/config.json`, which is part of the vault. This module reads
 * that choice through `settings`; it never persists anything itself.
 */
/** There is no `document` outside a browser, and this module is imported by
 *  code that runs under Vitest in node. */
const inBrowser = typeof document !== 'undefined'

class ChromeState {
  /** Read back from the pre-paint boot script rather than asked again. */
  dark = $state(inBrowser && document.documentElement.classList.contains('dark'))
  inspector = $state(true)
  index = $state(true)
  paletteOpen = $state(false)
  /** §02b Screen 6 is showing instead of the note. */
  settings = $state(false)

  /**
   * TODAY is showing instead of the note (§02b Screen 5).
   *
   * A property of this window, not of the vault: the aggregate stores nothing,
   * and which pane you last looked at is not knowledge. The open note stays
   * open underneath — the inspector keeps describing it — so leaving TODAY puts
   * you back exactly where you were.
   */
  today = $state(false)

  /**
   * §02b Screen 4 is showing instead of the note, resolving this copy.
   *
   * A path rather than a boolean, because the screen is *about* one conflict and
   * a vault can hold several. Null means it is not up. Like `today`, it is a
   * property of this window: the conflict itself is two files, and those are the
   * vault's.
   */
  conflict = $state<string | null>(null)

  /** Resolved on first use: constructing it eagerly would touch the DOM at
   *  module scope, which is what made this module unimportable in a test. */
  #scheme: MediaQueryList | null = null

  get #osScheme(): MediaQueryList {
    this.#scheme ??= matchMedia('(prefers-color-scheme: dark)')
    return this.#scheme
  }

  /**
   * The scheme the vault's config asks for, or the OS when it asks for nothing.
   *
   * §02b Screen 6 makes `.register/config.json` the durable store — which rule 4
   * allows, because that file is part of the vault. An unset scheme still means
   * "whatever the OS says", so a fresh vault behaves exactly as before.
   */
  get #preferred(): boolean {
    if (settings.scheme === 'light') return false
    if (settings.scheme === 'dark') return true
    return this.#osScheme.matches
  }

  /**
   * Lit when the display differs from what the OS asked for.
   *
   * Measured against the OS rather than against the stored scheme, because INV
   * now *is* the stored scheme: comparing it against its own result would leave
   * the key unlit the instant it took effect. The property the old comparison
   * was protecting still holds — a user whose OS is dark and who has chosen
   * nothing boots with the key dark, not lit for a state they never entered.
   */
  get inverted(): boolean {
    return this.dark !== this.#osScheme.matches
  }

  /** Put the stored scheme on the document. Idempotent; safe from an effect. */
  applyScheme(): void {
    const wanted = this.#preferred
    if (this.dark === wanted) return
    measure(() => {
      this.dark = wanted
      document.documentElement.classList.toggle('dark', wanted)
    })
  }

  /**
   * Choose the other scheme, and keep it.
   *
   * INV used to be a preview: it flipped the class and nothing else, so a reload
   * put the stored scheme straight back. That reads as a broken button —
   * press it, get light, refresh, get dark — and the distinction between "invert
   * the display" and "choose a scheme" was never visible on screen. It is now
   * the same act as pressing Light or Dark in §02b Screen 6.
   *
   * Applied first and saved after: the paint is what the user is waiting for,
   * and the write is a file. `applyScheme` will not fight it — by the time the
   * stored scheme lands, the document already agrees with it and its early
   * return holds.
   */
  invert(): void {
    const wanted = this.dark ? 'light' : 'dark'
    measure(() => {
      this.dark = !this.dark
      document.documentElement.classList.toggle('dark', this.dark)
    })
    void settings.setScheme(wanted)
  }

  /**
   * Follow the OS — unless the vault pinned a scheme in §02b Screen 6.
   *
   * A pin has to survive the machine going dark at sunset, or it is not a
   * setting. With no pin the OS wins, and any INV inversion is dropped.
   */
  followOsScheme(): () => void {
    const onChange = (event: MediaQueryListEvent) => {
      if (settings.scheme !== 'system') return
      measure(() => {
        this.dark = event.matches
        document.documentElement.classList.toggle('dark', this.dark)
      })
    }
    this.#osScheme.addEventListener('change', onChange)
    return () => this.#osScheme.removeEventListener('change', onChange)
  }

  /**
   * A request for the editor to take focus, optionally at an offset.
   *
   * A nonce rather than a bare offset, because clicking the same heading twice
   * has to move the caret twice — and the editor is a sibling of whatever asks,
   * so the request travels as state rather than as a call. One channel for both
   * intents: an OUTLINE row wants the caret moved, Enter from the frame just
   * wants the caret back, and both are "editor, take focus".
   */
  focusAt = $state<{ position: number | null; nonce: number } | null>(null)
  #nonce = 0

  /** Put the caret at an offset and scroll to it (the OUTLINE rows). */
  reveal(position: number): void {
    this.focusAt = { position, nonce: ++this.#nonce }
  }

  /** Return to the note, leaving the caret where it was. */
  focusEditor(): void {
    this.focusAt = { position: null, nonce: ++this.#nonce }
  }

  showSettings(): void {
    this.#only('settings')
  }

  showToday(): void {
    this.#only('today')
  }

  /** Raise §02b Screen 4 over `copy`, the parked revision being merged back. */
  showConflict(copy: string): void {
    this.#only('conflict')
    this.conflict = copy
  }

  showNotes(): void {
    this.#only(null)
  }

  /**
   * Raise one main view and lower the rest.
   *
   * §02b draws one main region, so two flags true renders whichever the template
   * happens to test first. With two views "also clear the other one" was reliable
   * by inspection; with three it is the kind of thing that gets forgotten in the
   * fourth, so the exclusion lives in one place instead of in every setter.
   */
  #only(view: 'settings' | 'today' | 'conflict' | null): void {
    this.settings = view === 'settings'
    this.today = view === 'today'
    if (view !== 'conflict') this.conflict = null
  }

  toggleInspector(): void {
    this.inspector = !this.inspector
  }

  toggleIndex(): void {
    this.index = !this.index
  }

  openPalette(): void {
    this.paletteOpen = true
  }

  closePalette(): void {
    this.paletteOpen = false
  }
}

export const chrome = new ChromeState()
