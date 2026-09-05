import { EditorState, type Extension } from '@codemirror/state'
import { drawSelection, EditorView } from '@codemirror/view'
import { markdownDecorations } from './decorations'
import { editorKeymap } from './keymap'
import { markdownLanguage } from './markdown'
import { editorTheme } from './theme'

/**
 * The whole extension set, hand-picked.
 *
 * Deliberately not `basicSetup` or the `codemirror` meta-package: those bring
 * autocomplete, lint, search, a fold gutter and line numbers — none of which
 * this design wants, and all of which spend the §06 budget.
 */
export function editorExtensions(options: { readOnly?: boolean } = {}): Extension {
  return [
    // `cursorBlinkRate: 0` is the kill switch for the only animation CodeMirror
    // ships. §02 permits exactly one animation in the product and it is the
    // status LED.
    drawSelection({ cursorBlinkRate: 0 }),
    editorKeymap,
    markdownLanguage,
    markdownDecorations,
    editorTheme,
    EditorView.lineWrapping,
    // An export (§12) reads with the same surface it would write with, and
    // both facets are needed for it to be a reading surface: `readOnly` is what
    // the commands and the task widget consult, and `editable` is what takes
    // the caret and the keyboard away. One without the other is a document
    // that refuses keystrokes while still inviting them.
    options.readOnly === true
      ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
      : [],
  ]
}
