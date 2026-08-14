import type { EditorState, Extension } from '@codemirror/state'
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { bodyOffset, fields, readsAsFields, split } from '../../core/frontmatter'

/**
 * Fold §04's frontmatter to one row.
 *
 * §12 requires that "markdown stays the literal source" and then says what the
 * roadmap has been waiting on since P11: **"anything that hides the source must
 * still pass §02."** So hiding is permitted rather than forbidden, on a
 * condition — and this is the ruling, taken because six lines of YAML above
 * every note repeated what the header already says and buried the writing under
 * the filing.
 *
 * What passes §02: the row is drawn in the micro layer with a hairline, it
 * shows its key, it inverts on hover like every other control, it is reachable
 * with Tab, and nothing is rewritten. The bytes are exactly where they were —
 * unfold and you are editing the same characters an agent reads.
 */

/** Fold (`true`) or unfold the block. */
export const setFrontmatterFold = StateEffect.define<boolean>()

/**
 * How much of the document to read when looking for the block.
 *
 * `split` wants a string and the document is the editor's own rope, so asking
 * for all of it would allocate a copy of the note on every keystroke. Six short
 * fields is what §04 defines; eight kilobytes is a very wide margin around that,
 * and a "frontmatter" longer than this simply does not fold — which is the same
 * answer an unreadable one gets, and is safe rather than wrong.
 */
const PREFIX = 8192

interface Block {
  /** Always 0: the block is the top of the file, byte-order mark included. */
  from: number
  /** End of the closing fence's line, so the range covers whole lines. */
  to: number
  count: number
}

/** The foldable block, or null when there is nothing to fold. */
function locate(state: EditorState): Block | null {
  const head = state.doc.sliceString(0, Math.min(state.doc.length, PREFIX))
  const parts = split(head)

  // No frontmatter, or a fence that never closes — `split` calls both of those
  // prose, and there is nothing to draw a row for.
  if (parts.open === '') return null
  // A note that is only frontmatter: folding it would leave a blank screen with
  // a row on it. All there is to see is the thing being hidden.
  if (parts.body.trim() === '') return null
  // A line that does not parse stays visible. See `readsAsFields`.
  if (!readsAsFields(head)) return null

  return {
    from: 0,
    to: state.doc.lineAt(bodyOffset(head) - 1).to,
    count: fields(head).size,
  }
}

interface Fold {
  folded: boolean
  block: Block | null
}

const foldState = StateField.define<Fold>({
  create: (state) => ({ folded: true, block: locate(state) }),

  update(value, transaction) {
    let folded = value.folded
    for (const effect of transaction.effects) {
      if (effect.is(setFrontmatterFold)) folded = effect.value
    }

    const block = transaction.docChanged ? locate(transaction.state) : value.block

    // Unfolded, and the caret has left the block: fold it again. This is what
    // keeps the top of a note clean without a second control to remember —
    // opening the block is a thing you do to edit it, so leaving is done.
    //
    // Read after the effects above, and never against a transaction that just
    // unfolded: the click that opens the block puts the caret inside it in the
    // same transaction, so the head is already within range.
    if (!folded && block !== null && transaction.selection !== undefined) {
      if (transaction.state.selection.main.head > block.to) folded = true
    }

    return { folded, block }
  },
})

class FoldRow extends WidgetType {
  constructor(readonly count: number) {
    super()
  }

  /** Identity is the count, so a field added while folded redraws the row. */
  override eq(other: FoldRow): boolean {
    return other.count === this.count
  }

  override toDOM(view: EditorView): HTMLElement {
    const row = document.createElement('div')
    row.className = 'cm-frontmatter-fold'
    row.setAttribute('role', 'button')
    row.setAttribute('tabindex', '0')
    row.setAttribute('aria-expanded', 'false')
    row.contentEditable = 'false'

    const label = document.createElement('span')
    // Sentence case in the DOM, uppercased by CSS, as all chrome is (§02). The
    // fences are repeated because the row stands in for them: what is hidden is
    // a `---` block, and the row says so rather than inventing a noun for it.
    label.textContent = `▸ --- ${this.count} ${this.count === 1 ? 'field' : 'fields'} ---`

    const key = document.createElement('span')
    key.className = 'cm-frontmatter-key'
    // §01: "every control shows its key".
    key.textContent = '↵'

    row.append(label, key)

    const open = (event: Event) => {
      event.preventDefault()
      unfold(view)
    }
    // mousedown rather than click, for `TaskToggle`'s reason: click fires after
    // the browser has moved the selection, which shows as a caret jump.
    row.addEventListener('mousedown', open)
    row.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') open(event)
    })
    return row
  }

  override ignoreEvent(): boolean {
    return false
  }
}

/**
 * Open the block and put the caret on its first field.
 *
 * Both halves matter: unfolding without moving the caret leaves the reader
 * looking at six lines they now have to click into, and the point of opening it
 * is to edit it.
 */
function unfold(view: EditorView): boolean {
  const held = view.state.field(foldState, false)
  if (held === undefined || held.block === null || !held.folded) return false

  // Line 1 is the opening fence, so line 2 is the first field — or the closing
  // fence, on a block with no fields in it at all.
  const first = view.state.doc.line(Math.min(2, view.state.doc.lines))
  view.dispatch({
    effects: setFrontmatterFold.of(false),
    selection: { anchor: Math.min(first.from, held.block.to) },
  })
  view.focus()
  return true
}

function decorate(value: Fold): DecorationSet {
  if (!value.folded || value.block === null) return Decoration.none
  return Decoration.set([
    Decoration.replace({
      widget: new FoldRow(value.block.count),
      block: true,
    }).range(value.block.from, value.block.to),
  ])
}

/**
 * The frontmatter fold: the state, the row that replaces it, and the rule that
 * keeps the caret out of text it cannot see.
 */
export const frontmatterFold: Extension = [
  foldState,
  EditorView.decorations.from(foldState, decorate),
  // Or the caret can be walked into text that is not on screen: ⌘↑ from the
  // body would land it inside the hidden block, where every keystroke edits
  // something invisible.
  EditorView.atomicRanges.of((view) => decorate(view.state.field(foldState))),
]
