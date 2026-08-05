import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { type WikiLinkHost, wikiLinkHost } from './decorations/wikilinks'
import { editorExtensions } from './setup'
import { isUserEdit, loadDoc, syncDoc } from './sync'

export type { WikiLinkHost }

export interface EditorOptions {
  parent: HTMLElement
  doc: string
  host: WikiLinkHost
  /** A real keystroke, never a programmatic sync. */
  onEdit: (doc: string) => void
  /** Cost of the update CodeMirror just performed, in milliseconds. */
  onRender: (ms: number) => void
}

export interface EditorHandle {
  /** Adopt an external change, preserving the cursor. */
  sync: (doc: string) => void
  /** Switch to a different note. */
  load: (doc: string) => void
  focus: () => void
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
    load: (doc) => loadDoc(view, doc),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
    setHost: (host) => {
      view.dispatch({ effects: hostSlot.reconfigure(wikiLinkHost.of(host)) })
    },
  }
}
