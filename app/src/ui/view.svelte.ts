import { measure } from '../lib/render.svelte'

/**
 * Chrome state: what is on screen, as opposed to what is in the vault.
 *
 * In memory only. Hard rule 4 forbids state the vault cannot express, and none
 * of this belongs in a note — the OS owns the colour scheme, and pane visibility
 * is a property of this window, not of the knowledge base.
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

  /**
   * TODAY is showing instead of the note (§02b Screen 5).
   *
   * A property of this window, not of the vault: the aggregate stores nothing,
   * and which pane you last looked at is not knowledge. The open note stays
   * open underneath — the inspector keeps describing it — so leaving TODAY puts
   * you back exactly where you were.
   */
  today = $state(false)

  /** Resolved on first use: constructing it eagerly would touch the DOM at
   *  module scope, which is what made this module unimportable in a test. */
  #scheme: MediaQueryList | null = null

  get #osScheme(): MediaQueryList {
    this.#scheme ??= matchMedia('(prefers-color-scheme: dark)')
    return this.#scheme
  }

  /**
   * INV means "inverted from the OS", not "dark is on" — otherwise a user whose
   * OS is dark boots with the key already lit for a state they never entered.
   */
  get inverted(): boolean {
    return this.dark !== this.#osScheme.matches
  }

  invert(): void {
    measure(() => {
      this.dark = !this.dark
      document.documentElement.classList.toggle('dark', this.dark)
    })
  }

  /**
   * The OS is the only durable source of truth for the scheme, because rule 4
   * forbids storing a preference — so when it changes it wins, and any INV
   * inversion is dropped.
   */
  followOsScheme(): () => void {
    const onChange = (event: MediaQueryListEvent) => {
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

  showToday(): void {
    this.today = true
  }

  showNotes(): void {
    this.today = false
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
