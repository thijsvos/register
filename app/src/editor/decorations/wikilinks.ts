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
}

const inert: WikiLinkHost = {
  exists: () => false,
  open: () => {},
  fileUrl: () => null,
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
