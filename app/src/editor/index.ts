import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { followLink } from './decorations'
import { type WikiLinkHost, wikiLinkHost } from './decorations/wikilinks'
import { editorExtensions } from './setup'
import { isUserEdit, loadDoc, scrollTo, syncDoc } from './sync'

export type { WikiLinkHost }

export interface EditorOptions {
  parent: HTMLElement
  doc: string
  /** Where to leave the caret — past the frontmatter, never at byte zero. */
  caret?: number
  host: WikiLinkHost
  /** How far the note was scrolled when it was last on screen. */
  scroll?: number
  /** A real keystroke, never a programmatic sync. */
  onEdit: (doc: string) => void
  /** Cost of the update CodeMirror just performed, in milliseconds. */
  onRender: (ms: number) => void
}

export interface EditorHandle {
  /** Adopt an external change, preserving the cursor. */
  sync: (doc: string) => void
  /** Switch to a different note, leaving the caret at `caret`. */
  load: (doc: string, caret?: number, scroll?: number) => void
  /**
   * Where the reader is: the caret, and how far the note is scrolled.
   *
   * Read before this view is torn down or handed a different note, so coming
   * back to one costs nothing. The scroll is the pixel offset rather than a
   * document position — it is what the reader was looking at, and a position
   * would have to be re-resolved against a note an agent may have changed.
   */
  place: () => { caret: number; scroll: number }
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

  scrollTo(view, options.scroll ?? 0)

  /**
   * The scroll offset, tracked rather than read on demand.
   *
   * `place()` is called as this editor is being torn down — the views that
   * replace a note are alternatives in one `{#if}` — and by then Svelte has
   * detached the scroller, so `scrollDOM.scrollTop` reads 0 however far down
   * the reader actually was. Measured: the caret came back and the scroll did
   * not. So the last offset seen while the element was live is what is kept.
   */
  let scrolled = options.scroll ?? 0
  const track = () => {
    scrolled = view.scrollDOM.scrollTop
  }
  view.scrollDOM.addEventListener('scroll', track, { passive: true })

  return {
    sync: (doc) => syncDoc(view, doc),
    load: (doc, caret, scroll) => {
      scrolled = scroll ?? 0
      loadDoc(view, doc, caret, scroll)
    },
    place: () => ({ caret: view.state.selection.main.head, scroll: scrolled }),
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
    destroy: () => {
      view.scrollDOM.removeEventListener('scroll', track)
      view.destroy()
    },
    setHost: (host) => {
      view.dispatch({ effects: hostSlot.reconfigure(wikiLinkHost.of(host)) })
    },
  }
}
