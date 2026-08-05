import { measure } from '../lib/render.svelte'

/**
 * Chrome state: what is on screen, as opposed to what is in the vault.
 *
 * In memory only. Hard rule 4 forbids state the vault cannot express, and none
 * of this belongs in a note — the OS owns the colour scheme, and pane visibility
 * is a property of this window, not of the knowledge base.
 */
class ChromeState {
  /** Read back from the pre-paint boot script rather than asked again. */
  dark = $state(document.documentElement.classList.contains('dark'))
  inspector = $state(true)
  index = $state(true)
  paletteOpen = $state(false)

  #osScheme = matchMedia('(prefers-color-scheme: dark)')

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
