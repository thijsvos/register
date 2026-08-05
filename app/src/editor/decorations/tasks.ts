import { type EditorView, WidgetType } from '@codemirror/view'

/**
 * Draws `[ ]` / `[x]` as a real control that edits the document.
 *
 * A `Decoration.replace` with a widget rather than a `Decoration.mark`, for
 * three reasons. Hard rule 2 wants a hairline box sized from `--s4`, and a mark
 * can only restyle glyphs that are already there — it cannot turn three
 * characters into a bordered square. A widget carries `role="checkbox"` and
 * `aria-checked`, which a mark cannot. And it hides the raw syntax, which is the
 * point of a rendered surface while markdown stays the literal source.
 *
 * The cost accepted: the caret cannot be placed inside the marker.
 */
export class TaskToggle extends WidgetType {
  constructor(
    readonly checked: boolean,
    /** Document position of the `[`. The state character is always at +1. */
    readonly at: number,
  ) {
    super()
  }

  /**
   * `at` is part of identity, not just `checked`: the DOM node closes over the
   * position, so reusing a node whose line has moved would toggle the wrong
   * character.
   */
  override eq(other: TaskToggle): boolean {
    return other.checked === this.checked && other.at === this.at
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span')
    box.className = 'cm-task-toggle'
    box.setAttribute('role', 'checkbox')
    box.setAttribute('aria-checked', String(this.checked))
    box.setAttribute('tabindex', '0')
    box.textContent = this.checked ? '×' : ''
    box.contentEditable = 'false'

    const toggle = (event: Event) => {
      event.preventDefault()
      // One character replaced, which is the smallest edit that expresses the
      // change — so the vault's diff stays clean and an agent reading the file
      // sees exactly what happened.
      view.dispatch({
        changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? ' ' : 'x' },
      })
    }

    // mousedown, not click: click fires after the browser has already moved the
    // selection, which shows up as a visible caret jump.
    box.addEventListener('mousedown', toggle)
    box.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') toggle(event)
    })
    return box
  }

  override ignoreEvent(): boolean {
    return false
  }
}
