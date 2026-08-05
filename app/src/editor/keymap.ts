import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import type { Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'

/**
 * Editing keys only. The application keymap — ⌘K, N, I, the G-chords — is P5's
 * and belongs to the window, not to the editor: binding it here would make it
 * work only while the editor has focus.
 */
export const editorKeymap: Extension = [
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
]
