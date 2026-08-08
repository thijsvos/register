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
 * Reach the index, at one end or the other.
 *
 * The counterpart to `traverse`: that one moves within the list, this one gets
 * you to it. Queried from the document rather than held as a reference, because
 * the caller is a window-level key handler with no component to ask — and the
 * index's accessible name is already the contract two e2e specs select it by.
 *
 * Returns whether focus actually moved. An index toggled off with `[` is not
 * rendered, and below 760px it is display:none where `focus()` is a no-op — and
 * the caller has to know, or it swallows the keystroke on behalf of a pane that
 * is not there. The palette's own `FOCUS · INDEX` row hides itself in that state;
 * the key had no equivalent and just went quiet.
 */
export function enterIndex(end: 'first' | 'last'): boolean {
  const rows = document.querySelectorAll<HTMLElement>('[aria-label="Index"] nav button')
  const row = end === 'first' ? rows[0] : rows[rows.length - 1]
  row?.focus()
  return row !== undefined && document.activeElement === row
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

  settings(): void {
    chrome.showSettings()
  },

  /** §02b Screen 4, over one `*.conflict-<ts>.md` copy. */
  conflict(copy: string): void {
    chrome.showConflict(copy)
  },

  /**
   * §02b Screen 4 over the newest unresolved conflict, or nowhere if there is
   * none.
   *
   * Here rather than at the call sites for the reason this module exists: the
   * status bar and the palette both offer "resolve the conflict", and both had
   * their own copy of "take `unresolved[0]`, guard it, route to it". Two copies
   * of a selection rule is how the two surfaces start disagreeing about which
   * conflict they mean.
   */
  newestConflict(): void {
    const first = vault.unresolved[0]
    if (first !== undefined) chrome.showConflict(first.copy.path)
  },
}
