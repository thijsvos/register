import { go } from './nav'
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
const platform =
  (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
  navigator.platform
const isMac = /mac/i.test(platform)

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

    // Escape closes the palette from anywhere, not only from its input. The
    // input handles it too, but relying on that alone means a stray focus makes
    // an open modal unclosable without a mouse.
    if (event.key === 'Escape') {
      disarm()
      if (chrome.paletteOpen) {
        event.preventDefault()
        chrome.closePalette()
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

    switch (event.key.toLowerCase()) {
      case 'g':
        event.preventDefault()
        chord = 'g'
        // Armed briefly, then forgotten: a `g` typed and abandoned must not
        // silently swallow whatever key comes next a minute later.
        armed = setTimeout(disarm, CHORD_MS)
        return
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
