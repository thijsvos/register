import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Range, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { misses } from '../../core/media.svelte'
import { wikiLinkHost } from './wikilinks'

/**
 * `![alt](src)`, read off the node the tree already reports.
 *
 * The extent comes from the `Image` node — which `@lezer/markdown` has always
 * emitted and this walk simply never asked for — so a reference inside a fenced
 * code block is not one. Only the two fields are pulled with a regex, over the
 * node's own ~60 characters rather than the document.
 */
export const IMAGE = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)/

/**
 * What CodeMirror should assume an undecoded image occupies.
 *
 * Not a CSS length — this is arithmetic for the scroll geometry of lines that
 * have not been drawn yet, and the real height comes from the stylesheet the
 * moment the bytes land. A guess in the right order of magnitude keeps a long
 * note from jumping as images decode; an exact value is neither available nor
 * needed.
 */
const ASSUMED_HEIGHT = 180

/**
 * The image a `![alt](src)` refers to, drawn under the line that refers to it.
 *
 * **Under, not instead of.** §12's parked entry for this feature says
 * "markdown stays the literal source, and anything that hides the source still
 * answers to §02" — and the roadmap still carries an *open* §02 question about
 * whether folding frontmatter counts as hiding. Replacing the reference would
 * answer that question by accident; leaving it visible does not ask it.
 *
 * A widget rather than a mark for the reason `TaskToggle` gives: a mark can only
 * restyle glyphs that are already there, and there is no glyph here to restyle.
 *
 * Whether the file exists is not knowable from the document — media is not in
 * the tree, by design — so it is discovered by the browser and reported by
 * `onerror`. That is why there is no "missing" variant chosen up front: the
 * widget renders optimistically and demotes itself.
 */
export class ImageEmbed extends WidgetType {
  constructor(
    /** The reference as written, which is what the viewer is opened with. */
    readonly src: string,
    readonly url: string,
    readonly alt: string,
    /** The document position, so a moved line gets a fresh node. */
    readonly at: number,
  ) {
    super()
  }

  /**
   * Position is part of identity, exactly as it is for `TaskToggle`: the DOM
   * node closes over it, so reusing one whose line has moved would leave the
   * image attached to the wrong reference.
   */
  override eq(other: ImageEmbed): boolean {
    return (
      other.url === this.url &&
      other.alt === this.alt &&
      other.src === this.src &&
      other.at === this.at
    )
  }

  /**
   * The first widget here to need one — `TaskToggle` is inline and CSS-sized.
   * CodeMirror uses it to guess the geometry of lines it has not drawn; without
   * it, scrolling past an undecoded image measures an empty box and visibly
   * corrects itself once the bytes arrive.
   */
  override get estimatedHeight(): number {
    return ASSUMED_HEIGHT
  }

  override toDOM(view: EditorView): HTMLElement {
    // Two elements, not one: the outer carries the gap as padding and the inner
    // carries the rule. A margin here would be outside the box CodeMirror
    // measures, which puts its height map out by exactly that much — see
    // `.cm-embed` in the theme for what that cost.
    const figure = document.createElement('div')
    figure.className = 'cm-embed'
    figure.contentEditable = 'false'

    const box = document.createElement('div')
    box.className = 'cm-embed-box'

    const image = document.createElement('img')
    image.className = 'cm-embed-image'
    image.src = this.url
    // The author's own alt text, and the only description this image will ever
    // have.
    image.alt = this.alt
    // Native: the browser skips work for images below the fold and decodes off
    // the main thread, which is §06's 16 ms interaction budget's business.
    image.loading = 'lazy'
    image.decoding = 'async'

    let gone = false
    image.addEventListener('error', () => {
      gone = true
      // The only place this is knowable. Recorded so the reference *text* can go
      // inert too, rather than staying dressed as a link to this same message.
      misses.mark(this.src)
      // §02b's wikilink matrix already has a word for "the target is not
      // there" — dotted and dim. Reused rather than invented, and it says what
      // is wrong instead of showing a broken-image glyph.
      figure.classList.add('cm-embed-missing')
      image.remove()
      const said = document.createElement('span')
      said.className = 'cm-embed-said'
      said.textContent =
        this.alt === '' ? 'Not in the vault' : `${this.alt} — not in the vault`
      box.append(said)
    })

    // mousedown rather than click: click fires after the browser has moved the
    // selection, which reads as the caret jumping before the surface opens.
    figure.addEventListener('mousedown', (event: MouseEvent) => {
      // Inert once the target has proved absent: opening the viewer would show
      // the same sentence this box is already showing.
      if (gone) return
      event.preventDefault()
      view.state.facet(wikiLinkHost).openFile(this.src)
    })

    box.append(image)
    figure.append(box)
    return figure
  }

  /** The widget's own listener handles the press. */
  override ignoreEvent(): boolean {
    return false
  }
}

/** Every renderable image reference in the document, as block widgets. */
function build(state: EditorState): DecorationSet {
  const embeds: Range<Decoration>[] = []
  const host = state.facet(wikiLinkHost)

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Image') return
      const parts = IMAGE.exec(state.doc.sliceString(node.from, node.to))
      const src = parts?.[2] ?? ''
      const url = src === '' ? null : host.fileUrl(src)
      if (url === null) return
      // Anchored to the end of the reference's own line, so the source stays
      // readable above its image and the widget never splits a paragraph.
      const line = state.doc.lineAt(node.to)
      embeds.push(
        Decoration.widget({
          widget: new ImageEmbed(src, url, parts?.[1] ?? '', node.from),
          block: true,
          side: 1,
        }).range(line.to),
      )
    },
  })

  return Decoration.set(embeds, true)
}

/**
 * A StateField rather than a ViewPlugin, and not by preference.
 *
 * CodeMirror refuses block decorations from a plugin — "Block decorations may
 * not be specified via plugins" — because a plugin is rebuilt from the viewport
 * and a block widget changes the height of lines the viewport has not measured.
 *
 * The cost of that is a whole-document walk instead of a viewport-limited one,
 * so it is gated on the two things that can change the answer: the text, and the
 * vault callbacks (an agent can add the file a reference points at while the
 * reader sits still). Everything else maps the existing set through the changes.
 */
export const imageEmbeds = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, transaction) {
    const hostMoved =
      transaction.startState.facet(wikiLinkHost) !== transaction.state.facet(wikiLinkHost)
    if (!transaction.docChanged && !hostMoved) return value.map(transaction.changes)
    return build(transaction.state)
  },
  provide: (field) => EditorView.decorations.from(field),
})
