import { enterIndex, go } from './nav'
import { chrome } from './view.svelte'

/** How long a `G` stays armed waiting for the second key of a chord. */
const CHORD_MS = 1500

/**
 * ⌘ on macOS, Ctrl everywhere else — resolved per platform rather than
 * accepting either.
 *
 * Ctrl-K on macOS is kill-to-end-of-line: it is in AppKit and it is in
 * CodeMirror's own defaultKeymap, which calls preventDefault but not
 * stopPropagation. Treating Ctrl as an alias for ⌘ therefore truncates the line
 * *and* opens the palette on top of the note it just cut.
 */
/**
 * Both signals, and either one is enough.
 *
 * `userAgentData.platform` is the modern API and `navigator.platform` is the
 * deprecated one, but the deprecated one is the honest one: it reports the real
 * OS, while the modern one is derived from the User-Agent string and therefore
 * lies whenever the UA is overridden — by a privacy extension, a device
 * emulator, or an automated browser. Trusting it alone leaves ⌘K dead on a Mac
 * whose browser claims to be Windows, which is a real configuration and was how
 * this was found.
 *
 * The asymmetry is deliberate: a false "not a Mac" costs the user every command
 * key, while a false "is a Mac" costs a Windows user one shortcut they can still
 * reach from the header button.
 */
const reported = [
  (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform,
  navigator.platform,
]
const isMac = reported.some((value) => /mac/i.test(value ?? ''))

/**
 * Is the event coming from somewhere that owns its own keys?
 *
 * This is what "when not editing" means, and getting it wrong makes the app
 * unusable: a bare `N` must insert an N when the caret is in a note. CodeMirror
 * is checked by ancestor because its editable surface is a contenteditable div
 * whose exact element varies.
 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.matches('input, textarea, select, [contenteditable="true"]')) return true
  return target.closest('.cm-editor') !== null
}

export type EscapeAction = 'close-palette' | 'leave-editor' | 'nothing'

/**
 * What Escape does — stated as a function of three facts, so the rule can be
 * read and tested without a DOM.
 *
 * Escape is the way out of the editor, and it has to be: opening a note puts the
 * caret in it, and while the caret is in it every bare key is a letter rather
 * than a command. Without this, `N`, `I`, `[`, `]` and the G-chords are reachable
 * only by clicking something, which is §01's mouse-free promise failing quietly
 * in the state the user spends nearly all their time in.
 *
 * Order matters. The palette is modal, so it wins from anywhere. Then anything
 * closer to the event wins: CodeMirror binds Escape to `simplifySelection`,
 * which collapses a multi-range or non-empty selection and calls preventDefault
 * — so a first Escape clears the selection and a second leaves the editor,
 * rather than one keystroke doing both.
 */
export function escapeAction(where: {
  paletteOpen: boolean
  /** Something nearer the target already consumed it. */
  handledAlready: boolean
  typing: boolean
}): EscapeAction {
  if (where.paletteOpen) return 'close-palette'
  if (where.handledAlready) return 'nothing'
  return where.typing ? 'leave-editor' : 'nothing'
}

/**
 * Whether Enter should hand the caret back to the note.
 *
 * Only from `<body>` — which is exactly where Escape leaves you, and nowhere
 * else. On a focused index row Enter has to open that row, and a global binding
 * would swallow it; the return trip must not cost the keyboard navigation it
 * exists to serve.
 */
export function entersEditor(where: { onBody: boolean; paletteOpen: boolean }): boolean {
  return where.onBody && !where.paletteOpen
}

/** Which end of the index a traversal key reaches into, or neither. */
export type IndexEntry = 'first' | 'last' | 'nothing'

/**
 * Whether a bare traversal key should move focus into the index, and where.
 *
 * §02b gives a nav row "↑↓ / j–k traversal", and until now that traversal could
 * only be *entered* by pressing Tab three times past the theme button. So the
 * index — the frame's primary navigation — was the one surface §01's mouse-free
 * promise did not really cover, and ⌘K was the only fast route to a note.
 *
 * `j` and `↓` arrive at the top, `k` and `↑` at the bottom: each key keeps the
 * direction it has everywhere else, so entering the list is the same gesture as
 * moving through it rather than a separate rule to remember.
 *
 * Only from `<body>`, which is the same rule `entersEditor` follows and for the
 * same reason. On a row, the row's own `traverse` owns these keys — and it
 * declines at the ends, so a global handler that also fired would turn the last
 * row's `j` into a jump back to the first.
 */
export function entersIndex(where: { key: string; onBody: boolean }): IndexEntry {
  if (!where.onBody) return 'nothing'
  const key = where.key.toLowerCase()
  if (key === 'j' || key === 'arrowdown') return 'first'
  if (key === 'k' || key === 'arrowup') return 'last'
  return 'nothing'
}

/**
 * The application keymap (§08 P5). Returns its own teardown.
 *
 * Deliberately on the window rather than in CodeMirror's keymap: bound there it
 * would only work while the editor had focus, and §01's promise is that every
 * action is reachable without a mouse from anywhere.
 */
export function installKeymap(): () => void {
  let chord: string | null = null
  let armed: ReturnType<typeof setTimeout> | undefined

  const disarm = () => {
    chord = null
    clearTimeout(armed)
  }

  const onKey = (event: KeyboardEvent) => {
    // ⌘K and ⌘D are the two keys that work from anywhere, mid-sentence included.
    const command = isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey
    const bare = command && !event.altKey && !event.shiftKey

    if (bare && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      disarm()
      if (chrome.paletteOpen) chrome.closePalette()
      else chrome.openPalette()
      return
    }

    // §02b Screen 2 draws this key against "GO · TODAY / TASKS", so that is what
    // it does. The daily log keeps G D, which is what §08 P7 calls GO DAILY.
    if (bare && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      disarm()
      chrome.closePalette()
      go.today()
      return
    }

    // Escape closes the palette from anywhere, not only from its input — the
    // input handles it too, but relying on that alone means a stray focus makes
    // an open modal unclosable without a mouse. Otherwise it leaves the editor.
    if (event.key === 'Escape') {
      disarm()
      // activeElement rather than event.target: it is the element about to be
      // blurred, so the thing tested and the thing acted on cannot disagree.
      const focused = document.activeElement
      const action = escapeAction({
        paletteOpen: chrome.paletteOpen,
        handledAlready: event.defaultPrevented,
        typing: isTyping(focused),
      })

      if (action === 'close-palette') {
        event.preventDefault()
        chrome.closePalette()
      } else if (action === 'leave-editor' && focused instanceof HTMLElement) {
        event.preventDefault()
        // Focus falls to <body>, where isTyping is false and the bare keys
        // work. The caret vanishing is the mode indicator: CodeMirror only
        // draws it while the view has focus, so this needs no new chrome.
        focused.blur()
      }
      return
    }

    // The palette owns every other key while it is open.
    if (chrome.paletteOpen) return

    // A modifier pressed on its own still fires a keydown. Falling through
    // would land in the chord branch and disarm a `g` the user had just armed,
    // so holding Shift to type a capital would silently cancel `g d`.
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return
    if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return

    if (chord === 'g') {
      const second = event.key.toLowerCase()
      disarm()
      if (second === 'd') {
        event.preventDefault()
        go.daily()
      } else if (second === 'i') {
        event.preventDefault()
        go.follow('000')
      } else if (second === 't') {
        event.preventDefault()
        go.today()
      }
      return
    }

    // After the chord branch, so an armed `g` still owns the key that follows it.
    const into = entersIndex({
      key: event.key,
      onBody: document.activeElement === document.body,
    })
    // Only claim the key if it actually went somewhere. With the index toggled
    // off there is nothing to focus, and swallowing `j` there would be a key
    // that does nothing and says nothing.
    if (into !== 'nothing' && enterIndex(into)) {
      event.preventDefault()
      return
    }

    switch (event.key.toLowerCase()) {
      case 'g':
        event.preventDefault()
        chord = 'g'
        // Armed briefly, then forgotten: a `g` typed and abandoned must not
        // silently swallow whatever key comes next a minute later.
        armed = setTimeout(disarm, CHORD_MS)
        return
      case 'enter': {
        // The way back in, and the reason Escape is safe to offer at all: leave
        // the editor with Escape, run a command, Enter to resume writing.
        const back = entersEditor({
          onBody: document.activeElement === document.body,
          // Already returned above if the palette is open. Passed anyway, so the
          // rule holds on its own rather than on the order of the branches here.
          paletteOpen: chrome.paletteOpen,
        })
        if (!back) return
        event.preventDefault()
        chrome.focusEditor()
        return
      }
      case 'n':
        event.preventDefault()
        go.create('Untitled note')
        return
      case 'i':
        event.preventDefault()
        chrome.invert()
        return
      case ']':
        event.preventDefault()
        chrome.toggleInspector()
        return
      case '[':
        event.preventDefault()
        chrome.toggleIndex()
        return
      default:
    }
  }

  window.addEventListener('keydown', onKey)
  return () => {
    disarm()
    window.removeEventListener('keydown', onKey)
  }
}
