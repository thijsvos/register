import { vault } from '../core/store.svelte'
import { chrome } from './view.svelte'

/** How long a `G` stays armed waiting for the second key of a chord. */
const CHORD_MS = 1500

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
    // ⌘K is the front door and works from anywhere, including mid-sentence.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      disarm()
      if (chrome.paletteOpen) chrome.closePalette()
      else chrome.openPalette()
      return
    }

    // The palette owns every other key while it is open; it closes on Escape
    // itself, so nothing here needs to reach past it.
    if (chrome.paletteOpen) return

    if (event.key === 'Escape') {
      disarm()
      return
    }
    if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return

    if (chord === 'g') {
      const second = event.key.toLowerCase()
      disarm()
      if (second === 'd') {
        event.preventDefault()
        void vault.openDaily()
      } else if (second === 'i') {
        event.preventDefault()
        void vault.follow('000')
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
        void vault.create('Untitled note')
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
