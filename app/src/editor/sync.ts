import {
  Annotation,
  ChangeSet,
  EditorSelection,
  type Transaction,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/**
 * Marks a transaction as originating outside the editor — a vault sync rather
 * than a keystroke.
 *
 * The payload is always `true` and is always tested with `=== true`:
 * `tr.annotation()` returns `undefined` when absent, so a falsy payload would be
 * indistinguishable from "not annotated" and a sync would be reported back to
 * the host as a user edit. That is the shape of the classic save/sync loop.
 */
export const Remote = Annotation.define<boolean>()

/** Whether a transaction is a real user edit rather than a programmatic sync. */
export function isUserEdit(transaction: Transaction): boolean {
  return transaction.docChanged && transaction.annotation(Remote) !== true
}

export interface DocDiff {
  from: number
  to: number
  insert: string
}

/** Do not split a surrogate pair: step back if `index` lands inside one. */
function unsplit(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index
  const lead = text.charCodeAt(index - 1)
  const trail = text.charCodeAt(index)
  const inside = lead >= 0xd800 && lead <= 0xdbff && trail >= 0xdc00 && trail <= 0xdfff
  return inside ? index - 1 : index
}

/**
 * The smallest single-range change turning `previous` into `next`: strip the
 * common prefix, then the common suffix, and replace what is left.
 *
 * A whole-document replace would work and is one line, but it destroys the
 * selection, the scroll position and every decoration — so an agent touching
 * the end of a note would throw the reader back to the top of it. No diff
 * library: prefix + suffix is enough for the edits agents actually make, and a
 * dependency here would spend the §06 budget on a nicety.
 */
export function minimalChange(previous: string, next: string): DocDiff | null {
  if (previous === next) return null

  const shortest = Math.min(previous.length, next.length)
  let head = 0
  while (head < shortest && previous.charCodeAt(head) === next.charCodeAt(head)) head++
  head = unsplit(next, head)

  // The suffix scan must not run back past the prefix in either string.
  const room = Math.min(previous.length - head, next.length - head)
  let tail = 0
  while (
    tail < room &&
    previous.charCodeAt(previous.length - 1 - tail) ===
      next.charCodeAt(next.length - 1 - tail)
  ) {
    tail++
  }
  tail = previous.length - unsplit(previous, previous.length - tail)

  return {
    from: head,
    to: previous.length - tail,
    insert: next.slice(head, next.length - tail),
  }
}

/**
 * Adopt `next` into the view, preserving the cursor.
 *
 * The selection is mapped through the change explicitly rather than left to
 * CodeMirror's default so the behaviour is visible here: a caret before the
 * edit stays put, a caret after it shifts by the delta, and a selection that
 * spans the edit keeps covering the same text.
 */
export function syncDoc(view: EditorView, next: string): void {
  const change = minimalChange(view.state.doc.toString(), next)
  if (change === null) return

  const changes = ChangeSet.of(change, view.state.doc.length)
  view.dispatch({
    changes,
    selection: view.state.selection.map(changes),
    annotations: Remote.of(true),
    scrollIntoView: false,
  })
}

/**
 * Replace the whole document, discarding the selection. Used when switching
 * notes.
 *
 * `caret` is where to leave it — the start of the prose, not of the file. The
 * editor is told the offset rather than working it out, so `core/frontmatter`
 * stays out of the lazy chunk.
 */
export function loadDoc(view: EditorView, text: string, caret = 0): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: EditorSelection.single(Math.min(Math.max(caret, 0), text.length)),
    annotations: Remote.of(true),
    scrollIntoView: false,
  })
}
