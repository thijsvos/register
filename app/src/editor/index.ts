import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { followLink } from './decorations'
import { setFrontmatterFold } from './decorations/frontmatter'
import { type WikiLinkHost, wikiLinkHost } from './decorations/wikilinks'
import { editorExtensions } from './setup'
import { isUserEdit, loadDoc, syncDoc } from './sync'

export type { WikiLinkHost }

export interface EditorOptions {
  parent: HTMLElement
  doc: string
  /** Where to leave the caret — past the frontmatter, never at byte zero. */
  caret?: number
  host: WikiLinkHost
  /** A real keystroke, never a programmatic sync. */
  onEdit: (doc: string) => void
  /** Cost of the update CodeMirror just performed, in milliseconds. */
  onRender: (ms: number) => void
}

export interface EditorHandle {
  /** Adopt an external change, preserving the cursor. */
  sync: (doc: string) => void
  /** Switch to a different note, leaving the caret at `caret`. */
  load: (doc: string, caret?: number) => void
  /** Put the caret at an offset and scroll it to the top — the OUTLINE pane. */
  reveal: (position: number) => void
  focus: () => void
  /**
   * Follow the link the caret is in, reporting whether there was one.
   *
   * The same command `Mod-Enter` runs. It is on the handle as well so ⌘K can
   * name the key — §01 asks every control to show its key, and the palette is
   * where this product says them.
   */
  follow: () => boolean
  destroy: () => void
  /** Swap the vault callbacks without tearing the editor down. */
  setHost: (host: WikiLinkHost) => void
}

export function createEditor(options: EditorOptions): EditorHandle {
  const hostSlot = new Compartment()

  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.doc,
      // The first note of a session never goes through `load`, so without this
      // it would be the one note whose caret still starts above the fence.
      selection: {
        anchor: Math.min(Math.max(options.caret ?? 0, 0), options.doc.length),
      },
      extensions: [
        editorExtensions(),
        hostSlot.of(wikiLinkHost.of(options.host)),
        EditorView.updateListener.of((update) => {
          const started = performance.now()

          if (update.transactions.some(isUserEdit)) {
            options.onEdit(update.state.doc.toString())
          }
          if (update.docChanged) {
            // read() runs in CodeMirror's measure phase, after the DOM write, so
            // this covers the work the update actually caused.
            update.view.requestMeasure({
              read: () => performance.now() - started,
              write: (ms) => options.onRender(ms),
            })
          }
        }),
      ],
    }),
  })

  return {
    sync: (doc) => syncDoc(view, doc),
    load: (doc, caret) => {
      loadDoc(view, doc, caret)
      // Every note opens folded, whatever the last one was left as. Said here
      // rather than inferred from the change, because "a different note" is
      // something only the caller knows: `sync` replaces text too, and an agent
      // editing the note you have open must not shut the block you opened.
      view.dispatch({ effects: setFrontmatterFold.of(true) })
    },
    reveal: (position) => {
      // The pane derives its offsets from the store's buffer, which reaches the
      // editor a tick later; clamping means a click during that tick lands at
      // the end of the document instead of throwing out of a click handler.
      const at = Math.min(Math.max(position, 0), view.state.doc.length)
      view.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: 'start' }),
      })
      // No doc change, so `isUserEdit` is false and this never reports itself
      // back to the store as an edit. Focus follows the caret: the point of the
      // outline is to get you into the note, not to point at it.
      view.focus()
    },
    focus: () => view.focus(),
    follow: () => followLink(view),
    destroy: () => view.destroy(),
    setHost: (host) => {
      view.dispatch({ effects: hostSlot.reconfigure(wikiLinkHost.of(host)) })
    },
  }
}
