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
export function loadDoc(view: EditorView, text: string, caret = 0, scroll = 0): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: EditorSelection.single(Math.min(Math.max(caret, 0), text.length)),
    annotations: Remote.of(true),
    scrollIntoView: false,
  })
  scrollTo(view, scroll)
}

/**
 * How long to keep putting the scroller back while the note settles.
 *
 * An image decodes after the document is laid out, so the note grows for a few
 * frames after it opens. One second is far longer than a local decode and short
 * enough that a note which can never reach the offset — because it is shorter
 * than it was — stops trying rather than holding a listener for the session.
 */
const SETTLE_MS = 1000

/**
 * Put the scroller back where it was.
 *
 * Assigned directly rather than through `scrollIntoView`, because the two mean
 * different things: this restores the pixel offset a reader left, and that one
 * puts a position at the top or the middle of the viewport. Coming back to a
 * note should look like nothing happened.
 *
 * Re-applied while the content is still growing, which is the part that had to
 * be measured rather than assumed. A single write in the measure phase is not
 * enough: the images have not decoded, the scroller is shorter than it will be,
 * and the browser clamps the offset to the height it has right now. Measured on
 * a real note — left at 1132, restored to 939, and it stayed there while the
 * document grew back to its full height around it.
 *
 * Stops as soon as the offset is reached, or the moment the reader scrolls
 * themselves: correcting somebody's own scroll would be worse than the bug.
 */
export function scrollTo(view: EditorView, top: number): void {
  if (top <= 0) return
  const scroller = view.scrollDOM
  const wanted = Math.round(top)
  /** The last offset this function wrote, to tell our scrolling from theirs. */
  let written = -1

  const stop = () => {
    growth.disconnect()
    scroller.removeEventListener('scroll', theirs)
    clearTimeout(timer)
  }

  const apply = () => {
    scroller.scrollTop = top
    written = Math.round(scroller.scrollTop)
    // Reached it, or the note is as far down as it goes.
    if (written === wanted) stop()
  }

  const theirs = () => {
    if (Math.round(scroller.scrollTop) !== written) stop()
  }

  const growth = new ResizeObserver(() => apply())
  const timer = setTimeout(stop, SETTLE_MS)

  scroller.addEventListener('scroll', theirs, { passive: true })
  growth.observe(view.contentDOM)
  view.requestMeasure({ read: () => undefined, write: apply })
}
