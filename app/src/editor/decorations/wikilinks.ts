import { Facet } from '@codemirror/state'

// One definition of what a wikilink is, shared with the backlink graph. Two
// regexes would drift, and the first symptom would be a link the editor
// underlines and follows that no BACKLINKS pane ever lists.
export { WIKILINK } from '../../core/links'

/** What the editor needs to know about the vault, without owning any of it. */
export interface WikiLinkHost {
  /** Does a note with this title or ref exist? */
  exists: (target: string) => boolean
  /** Open it, creating it first if it is missing (§02b: create-on-miss). */
  open: (target: string) => void
  /**
   * Where a `![alt](src)` reference is served from, or `null` when it is not a
   * vault file this app will serve.
   *
   * Resolution needs the open note's own path, which the editor does not know —
   * it is handed a document, not a location. So it lives with the other
   * callbacks rather than in the widget.
   */
  fileUrl: (src: string) => string | null
  /** Open a referenced file on its own surface (§02b Screen 8). */
  openFile: (src: string) => void
  /**
   * Report that this reference just failed to load.
   *
   * Routed through the host rather than written straight to the miss store,
   * for the same reason `fileUrl` and `openFile` are: `src` is relative to the
   * note holding it, and only the host knows which note that is. Marked by the
   * raw string, a missing `shot.png` under `notes/` also declared the perfectly
   * good `archive/shot.png` missing — the reference in the second note went
   * dotted, dim and unclickable directly above the block widget rendering the
   * image it claimed was not there.
   */
  fileGone: (src: string) => void
  /**
   * Has the file this reference resolves to already failed to load in this
   * session?
   *
   * Only ever true after a browser has tried, because nothing else can know —
   * media is not in the tree. So a reference starts out dressed as a link and
   * goes inert once its target proves absent.
   */
  fileMissing: (src: string) => boolean
}

const inert: WikiLinkHost = {
  exists: () => false,
  open: () => {},
  fileUrl: () => null,
  openFile: () => {},
  fileGone: () => {},
  fileMissing: () => false,
}

/**
 * A Facet, not a StateField and not a plugin constructor argument.
 *
 * A StateField is for values derived from the document that must be mapped
 * through a ChangeSet on every transaction; a pair of callbacks is neither, so a
 * field would cost an `update()` per keystroke to carry something that never
 * changes with the text. Constructor arguments bake the callbacks in at plugin
 * creation, so swapping them would tear the plugin down — and a WidgetType only
 * ever receives an EditorView, from which a facet is readable and a constructor
 * argument is not.
 */
export const wikiLinkHost = Facet.define<WikiLinkHost, WikiLinkHost>({
  combine: (values) => values[0] ?? inert,
  compare: (a, b) => a === b,
})
