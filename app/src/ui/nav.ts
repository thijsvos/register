import { vault } from '../core/store.svelte'
import { chrome } from './view.svelte'

/**
 * §02b nav row: "↑↓ / j–k traversal".
 *
 * Shared rather than repeated per pane, because the state matrix describes one
 * component. Three panes with three slightly different traversals is exactly the
 * drift §02b exists to stop.
 */
export function traverse(event: KeyboardEvent): void {
  const forward = event.key === 'ArrowDown' || event.key === 'j'
  const back = event.key === 'ArrowUp' || event.key === 'k'
  if (!forward && !back) return

  const row = event.currentTarget
  if (!(row instanceof HTMLElement)) return

  const sibling = forward ? row.nextElementSibling : row.previousElementSibling
  if (sibling instanceof HTMLElement) {
    event.preventDefault()
    sibling.focus()
  }
}

/**
 * Every route into a note, in one place.
 *
 * The store does not know TODAY exists — it is chrome, and core has no business
 * holding a view flag. But every one of these lands the user in a note, so every
 * one of them has to put the note back on screen. Scattered across the sidebar,
 * the palette, the keymap and the inspector that is four places to forget; here
 * it is one, and forgetting it means a note opening behind an aggregate that is
 * still showing yesterday's tasks.
 */
export const go = {
  note(path: string): void {
    chrome.showNotes()
    void vault.open(path)
  },

  create(title: string, from?: string): void {
    chrome.showNotes()
    void vault.create(title, from)
  },

  daily(): void {
    chrome.showNotes()
    void vault.openDaily()
  },

  follow(target: string): void {
    chrome.showNotes()
    void vault.follow(target)
  },

  today(): void {
    chrome.showToday()
  },
}
