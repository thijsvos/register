import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { type Extension, Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { followFocusedLink, followLink } from './decorations'

/**
 * Editing keys only. The application keymap — ⌘K, N, I, the G-chords — is P5's
 * and belongs to the window, not to the editor: binding it here would make it
 * work only while the editor has focus.
 *
 * The one exception is `Mod-Enter`, and it is an editing key: it acts on what
 * the caret is inside. §01 promises every action without a mouse and the link
 * was the action with no key, so following one is bound here rather than in the
 * window, where it would have no caret to read.
 *
 * Enter and Space are here for the other half: a mark the reader reached with
 * Tab. Both are the a11y idiom for activating something with `role="link"`, and
 * both fall straight through unless a mark actually holds focus.
 *
 * `Prec.high` because `defaultKeymap` already binds all three — Mod-Enter to
 * insertBlankLine, Enter to insertNewlineAndIndent. Every command here returns
 * false when it has nothing to follow, so the editor keeps the whole rest of
 * the document and each binding claims only the case it can serve.
 */
export const editorKeymap: Extension = [
  history(),
  Prec.high(
    keymap.of([
      { key: 'Mod-Enter', run: followLink },
      { key: 'Enter', run: followFocusedLink },
      { key: 'Space', run: followFocusedLink },
    ]),
  ),
  keymap.of([...defaultKeymap, ...historyKeymap]),
]
