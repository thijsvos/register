import { folders } from '../core/paths'
import { vault } from '../core/store.svelte'
import { notesUnder } from '../core/tree'
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
 * The INDEX tree's own keys, on top of `traverse` (§02b Screen 1, Rev N).
 *
 * The WAI-ARIA tree pattern, which is worth following exactly because the whole
 * argument for a tree was that people already know how one behaves — and they
 * know it from widgets that obey this:
 *
 *   →  a folded folder opens · an open folder steps into its first child
 *   ←  an open folder folds · anything else steps out to its parent
 *
 * `h`/`l` alias the arrows the way `j`/`k` already alias `↑`/`↓`. Neither is
 * bound globally, and these handlers only fire on a focused row.
 *
 * Folding goes through the row's own click rather than calling the setter, so
 * the keyboard and the mouse take one path and the fold is persisted by the
 * same code either way. Depth is read from the DOM because the rows are flat
 * siblings — the tree is drawn by indentation, so the nesting a parent lookup
 * needs is not in the element hierarchy to be walked.
 */
export function treeTraverse(event: KeyboardEvent): void {
  if (event.key === 'Delete' || event.key === 'Backspace') {
    armFromRow(event)
    return
  }

  const right = event.key === 'ArrowRight' || event.key === 'l'
  const left = event.key === 'ArrowLeft' || event.key === 'h'
  if (!right && !left) {
    traverse(event)
    return
  }

  const row = event.currentTarget
  if (!(row instanceof HTMLElement)) return

  // `null` for a note: only folders carry the attribute, so this is also the
  // test for "is this row a folder" without a second one that could disagree.
  const expanded = row.getAttribute('aria-expanded')

  if (right) {
    if (expanded === 'false') {
      event.preventDefault()
      row.click()
    } else if (expanded === 'true') {
      // The row after an open folder is its first child, always: a folder only
      // exists because notes are under it, and expanding renders them next.
      // This started as a `depth === here + 1` guard, which no reachable state
      // could violate — an unfalsifiable branch reads as care and tests as
      // nothing, so it is gone rather than uncovered.
      focus(event, row.nextElementSibling)
    }
    return
  }

  if (expanded === 'true') {
    event.preventDefault()
    row.click()
    return
  }
  // A note, or an already-folded folder: step out. The first row above with a
  // smaller depth is the parent, whatever is in between.
  focus(event, parentOf(row))
}

/**
 * The folder a focused INDEX row would create a note into, or null.
 *
 * A folder row means itself; a note row means the folder it is in, so `N` puts
 * the new note beside the one you were reading rather than back at the top of
 * the vault. Null when focus is not on a row at all, which is how `N` keeps its
 * old meaning everywhere else.
 */
export function focusedFolder(): string | null {
  const row = document.activeElement
  if (!(row instanceof HTMLElement)) return null
  if (row.closest('[aria-label="Index"]') === null) return null

  const path = row.dataset.path
  if (path === undefined) return null
  if (row.dataset.kind === 'folder') return path

  const trail = folders(path)
  return trail.length === 0 ? null : trail.join('/')
}

/**
 * `⌫` on a focused INDEX row: arm the palette against what that row names.
 *
 * The row is the natural place to point at a folder — the palette can only
 * infer one from the open note — and this is what lets the INDEX offer a
 * deletion without the nav row itself changing at all. No new button, no
 * context menu, no §02b state the matrix does not already describe.
 *
 * Both keys, because they are the same key: `Delete` is what a full keyboard
 * sends and `Backspace` is what the one labelled ⌫ on a Mac sends, and a reader
 * pressing the key that says delete on it should not have to know which.
 */
function armFromRow(event: KeyboardEvent): void {
  const row = event.currentTarget
  if (!(row instanceof HTMLElement)) return
  const path = row.dataset.path
  if (path === undefined) return

  event.preventDefault()
  chrome.arm(
    row.dataset.kind === 'folder'
      ? { kind: 'folder', path, notes: notesUnder(vault.tree, path) }
      : { kind: 'note', path, notes: 1 },
  )
}

/**
 * The row this one is nested under: the nearest one above it drawn shallower.
 *
 * Not simply the row above. Those coincide for a folder's first child and
 * nowhere else — the row above `001 Alpha` at depth 1 is whatever ended the
 * subtree before it, which can be several levels deeper.
 */
function parentOf(row: HTMLElement): HTMLElement | null {
  const depth = deep(row)
  let at = row.previousElementSibling
  while (at instanceof HTMLElement) {
    if (deep(at) < depth) return at
    at = at.previousElementSibling
  }
  return null
}

const deep = (row: HTMLElement) => Number(row.dataset.depth ?? '0')

function focus(event: KeyboardEvent, row: Element | null): void {
  if (!(row instanceof HTMLElement)) return
  event.preventDefault()
  row.focus()
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

  create(title: string, from?: string, folder?: string): void {
    chrome.showNotes()
    void vault.create(title, from, folder)
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

  /** §02b Screen 8, over a vault file a note references. */
  file(path: string): void {
    chrome.showMedia(path)
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
