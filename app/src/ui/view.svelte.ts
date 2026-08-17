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

/**
 * A deletion waiting to be confirmed.
 *
 * `notes` is what the INDEX can see under it, which is what the confirm names —
 * and deliberately not what will actually be moved: the server takes the media
 * too, and the notice afterwards reports its own count. Promising a number the
 * client cannot know would be worse than showing the one it can and correcting
 * it with the truth.
 */
export interface Pending {
  kind: 'note' | 'folder'
  path: string
  notes: number
}

/** Where a note was being read: the caret, and how far it was scrolled. */
export interface Place {
  caret: number
  scroll: number
}

class ChromeState {
  /** Read back from the pre-paint boot script rather than asked again. */
  dark = $state(inBrowser && document.documentElement.classList.contains('dark'))
  inspector = $state(true)
  index = $state(true)
  paletteOpen = $state(false)

  /**
   * The deletion the palette is currently asking about, or null.
   *
   * Held here rather than in the palette so the two surfaces that can start one
   * — a focused INDEX row and a palette command — hand over the same shape, and
   * so closing the palette is the only place that has to clear it.
   */
  pending = $state<Pending | null>(null)
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

  /**
   * §02b Screen 8 is showing instead of the note: a vault file, by path.
   *
   * A path rather than a boolean for `conflict`'s reason — the screen is *about*
   * one file — and in memory rather than in the vault for `today`'s: which pane
   * you last looked at is not knowledge.
   */
  media = $state<string | null>(null)

  /** Whether a main view is showing instead of the note (§02b Screens 5, 6, 8). */
  get raised(): boolean {
    return this.settings || this.today || this.media !== null
  }

  /**
   * Where the reader was in each note, so leaving one and coming back does not
   * cost their place.
   *
   * The editor is destroyed when any of the raised views above replaces it —
   * they are alternatives in one `{#if}`, not layers — so clicking an image and
   * returning used to rebuild the note with the caret past the frontmatter and
   * the scroll at zero. On a long note that is not "back", it is the top.
   *
   * In memory, like every other property of this window: hard rule 4 forbids
   * state the vault cannot express, and how far down a note somebody had read
   * ten seconds ago is not knowledge about their notes. Deliberately not
   * `$state` — it is read when the editor mounts and never during a render, so
   * making it reactive would only invalidate things that do not depend on it.
   */
  #reading = new Map<string, Place>()

  rememberPlace(path: string, place: Place): void {
    this.#reading.set(path, place)
  }

  placeIn(path: string): Place | undefined {
    return this.#reading.get(path)
  }

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

  /**
   * A request for the editor to follow the link at its caret (§01).
   *
   * A bare nonce, because unlike `focusAt` the request carries nothing: the
   * caret already knows which link is meant, and the palette — which is what
   * asks — has no way to find out and no business deciding.
   */
  followAt = $state(0)

  followLink(): void {
    this.followAt = ++this.#nonce
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

  /** Raise §02b Screen 8 over a file the open note references. */
  showMedia(path: string): void {
    this.#only('media')
    this.media = path
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
  #only(view: 'settings' | 'today' | 'conflict' | 'media' | null): void {
    this.settings = view === 'settings'
    this.today = view === 'today'
    if (view !== 'conflict') this.conflict = null
    if (view !== 'media') this.media = null
  }

  toggleInspector(): void {
    this.inspector = !this.inspector
  }

  toggleIndex(): void {
    this.index = !this.index
  }

  /**
   * What the palette opens with in its box.
   *
   * Read once, when the surface mounts. Clicking a tag is the only thing that
   * sets it: §02b defines no tag component, so rather than inventing a state
   * the click hands the question to the surface that already answers it.
   */
  paletteSeed = $state('')

  openPalette(seed = ''): void {
    this.paletteSeed = seed
    this.paletteOpen = true
  }

  closePalette(): void {
    this.paletteOpen = false
    // An armed deletion does not survive the surface that was asking about it.
    // Leaving it set would re-arm the palette the next time ⌘K opened it, which
    // is the one way a confirm step can be worse than no confirm step.
    this.pending = null
  }

  /**
   * Raise the palette already asking about a deletion (§02b Screen 2, Rev P).
   *
   * The palette rather than a new component: it is already the app's dialog, it
   * is already keyboard-first, and §02b's answer to a modal elsewhere was "never
   * a modal". So a destructive action arms it instead of inventing a second
   * surface with its own focus handling to get wrong.
   *
   * This is also how the INDEX gets a delete without the nav row growing one.
   * `⌫` on the focused row hands its target here; the row itself is unchanged,
   * so the §02b state matrix for a nav row still describes it exactly.
   */
  arm(target: Pending): void {
    this.pending = target
    this.paletteOpen = true
  }
}

export const chrome = new ChromeState()
