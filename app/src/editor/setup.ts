import type { Extension } from '@codemirror/state'
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
export function editorExtensions(): Extension {
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
  ]
}
