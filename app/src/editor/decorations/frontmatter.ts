import type { EditorState, Extension } from '@codemirror/state'
import { StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { bodyOffset, canHideFrontmatter, split } from '../../core/frontmatter'

/**
 * Take §04's frontmatter off the editing surface.
 *
 * §12 requires that "markdown stays the literal source" and then states the
 * test the roadmap had been reading as a prohibition: **"anything that hides
 * the source must still pass §02."** Hiding is permitted on a condition, and
 * the condition here is that the fields do not stop being editable — the
 * inspector's PROPERTIES pane edits them, in the literal text they are written
 * in, and `setField` splices one line so every other byte survives.
 *
 * Nothing is drawn in the block's place. A row saying "six fields are hidden
 * here" is a second control on the surface that exists to have nothing on it,
 * which is what the first attempt at this got wrong.
 *
 * The block stays visible when the pane could not faithfully stand in for it —
 * see `canHideFrontmatter`. That is the whole safety argument: what is hidden
 * is always exactly what the inspector is showing.
 */
function decorate(state: EditorState): DecorationSet {
  // `split` wants a string and the document is a rope, so asking for all of it
  // would copy the note on every keystroke. Six short fields is what §04
  // defines; this is a very wide margin around that, and a "frontmatter" longer
  // than it simply is not hidden — the same answer an unreadable one gets.
  const head = state.doc.sliceString(0, Math.min(state.doc.length, PREFIX))
  const parts = split(head)

  if (!canHideFrontmatter(head)) return Decoration.none
  // A note that is only frontmatter would hide to a blank screen. All there is
  // to see is the thing being taken away.
  if (parts.body.trim() === '') return Decoration.none

  return Decoration.set([
    // Whole lines, from byte zero to the end of the closing fence's line, which
    // is what a block decoration requires and what the block actually is.
    Decoration.replace({ block: true }).range(
      0,
      state.doc.lineAt(bodyOffset(head) - 1).to,
    ),
  ])
}

const PREFIX = 8192

const hidden = StateField.define<DecorationSet>({
  create: decorate,
  update: (value, transaction) =>
    transaction.docChanged ? decorate(transaction.state) : value,
})

export const frontmatterHidden: Extension = [
  hidden,
  EditorView.decorations.from(hidden),
  // Or the caret can be walked into text that is not on screen: ⌘↑ from the
  // body would land it above the opening fence, where the first character typed
  // pushes the fence off byte zero and the note stops being a note.
  EditorView.atomicRanges.of((view) => view.state.field(hidden)),
]
