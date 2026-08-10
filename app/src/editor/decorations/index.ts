import { syntaxTree } from '@codemirror/language'
import type { Extension, Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { imageEmbeds } from './media'
import { TaskToggle } from './tasks'
import { WIKILINK, wikiLinkHost } from './wikilinks'

const HEADING = new Map([
  ['ATXHeading1', 'cm-h1'],
  ['ATXHeading2', 'cm-h2'],
  ['ATXHeading3', 'cm-h3'],
  ['ATXHeading4', 'cm-h4'],
  ['ATXHeading5', 'cm-h5'],
  ['ATXHeading6', 'cm-h6'],
])

const headingMarks = new Map(
  [...HEADING].map(([node, css]) => [node, Decoration.mark({ class: css })]),
)
const hashMark = Decoration.mark({ class: 'cm-hash' })
const inlineCodeMark = Decoration.mark({ class: 'cm-inline-code' })
const fencedCodeMark = Decoration.mark({ class: 'cm-fenced-code' })
const doneMark = Decoration.mark({ class: 'cm-task-done' })
const wikiPresent = Decoration.mark({
  class: 'cm-wiki',
  attributes: { role: 'link', tabindex: '0' },
})
const wikiMissing = Decoration.mark({
  class: 'cm-wiki cm-wiki-missing',
  attributes: { role: 'link', tabindex: '0' },
})
/**
 * A `[text](spec.pdf)` whose target is a file this app can show.
 *
 * Only those: an ordinary link to another note, or to the web, keeps the demoted
 * ink the HighlightStyle already gives it. Marking every link would promise a
 * surface for targets there is none for.
 */
const fileLink = Decoration.mark({
  class: 'cm-filelink',
  attributes: { role: 'link', tabindex: '0' },
})

/** The destination of a markdown inline link, as the tree hands it over. */
const LINK = /^\[[^\]]*\]\(\s*<?([^)\s>]+)/

/**
 * Decorations for the visible ranges only.
 *
 * Viewport-limited on purpose: rebuilding over the whole document on every
 * keystroke is what breaks §06's 60fps typing budget on a long note. The syntax
 * tree is incremental, so this stays proportional to what is on screen.
 */
function build(view: EditorView): DecorationSet {
  const marks: Range<Decoration>[] = []
  const host = view.state.facet(wikiLinkHost)
  const tree = syntaxTree(view.state)

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const heading = headingMarks.get(node.name)
        if (heading !== undefined) {
          marks.push(heading.range(node.from, node.to))
          return
        }
        if (node.name === 'HeaderMark') {
          marks.push(hashMark.range(node.from, node.to))
          return
        }
        if (node.name === 'InlineCode') {
          marks.push(inlineCodeMark.range(node.from, node.to))
          return
        }
        if (node.name === 'FencedCode') {
          marks.push(fencedCodeMark.range(node.from, node.to))
          return
        }
        // `Image` is a Link's sibling in the grammar, and an image reference is
        // already drawn by `imageEmbeds` — so this must not claim it too.
        if (node.name === 'Link') {
          const written = view.state.doc.sliceString(node.from, node.to)
          const target = LINK.exec(written)?.[1] ?? ''
          // A note is not media. `fileUrl` resolves any vault-relative path,
          // `.md` included, so without this a `[text](other.md)` would be
          // dressed as a link to a surface that answers 415 for it. Notes are
          // linked with `[[wikilinks]]`; this is for the files beside them.
          const servable = target !== '' && !/\.md$/i.test(target)
          if (servable && host.fileUrl(target) !== null) {
            marks.push(fileLink.range(node.from, node.to))
          }
          return
        }
        if (node.name === 'TaskMarker') {
          const checked = /x/i.test(view.state.doc.sliceString(node.from, node.to))
          marks.push(
            Decoration.replace({ widget: new TaskToggle(checked, node.from) }).range(
              node.from,
              node.to,
            ),
          )
          if (checked) {
            // §02b Task, active: "[x] + dim strikethrough".
            const line = view.state.doc.lineAt(node.from)
            if (node.to < line.to) marks.push(doneMark.range(node.to, line.to))
          }
        }
      },
    })

    // Wikilinks are not a markdown construct, so they are matched over the
    // visible text rather than read off the tree.
    const text = view.state.doc.sliceString(from, to)
    for (const match of text.matchAll(WIKILINK)) {
      const start = from + (match.index ?? 0)
      const target = (match[1] ?? '').trim()
      const mark = host.exists(target) ? wikiPresent : wikiMissing
      marks.push(mark.range(start, start + match[0].length))
    }
  }

  return Decoration.set(marks, true)
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = build(view)
    }

    update(update: ViewUpdate) {
      // The facet is in the list because the vault index changes underneath a
      // static document: a wikilink's target can be created by an agent while
      // the reader sits still, and a dotted link must become a dashed one.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState.facet(wikiLinkHost) !== update.state.facet(wikiLinkHost)
      ) {
        this.decorations = build(update.view)
      }
    }
  },
  {
    decorations: (value) => value.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const target = event.target
        if (!(target instanceof HTMLElement)) return false

        // A link to a vault file opens §02b Screen 8. Checked before the
        // wikilink branch because the two marks never overlap and this one is
        // the cheaper test.
        const file = target.closest('.cm-filelink')
        if (file !== null) {
          const position = view.posAtDOM(file)
          const line = view.state.doc.lineAt(position)
          const found = LINK.exec(line.text.slice(position - line.from))?.[1]
          const written = found ?? LINK.exec(line.text)?.[1]
          if (written !== undefined) {
            event.preventDefault()
            view.state.facet(wikiLinkHost).openFile(written)
            return true
          }
        }

        const link = target.closest('.cm-wiki')
        if (link === null) return false

        const position = view.posAtDOM(link)
        const line = view.state.doc.lineAt(position)
        for (const match of line.text.matchAll(WIKILINK)) {
          const start = line.from + (match.index ?? 0)
          if (position >= start && position <= start + match[0].length) {
            event.preventDefault()
            view.state.facet(wikiLinkHost).open((match[1] ?? '').trim())
            return true
          }
        }
        return false
      },
    },
  },
)

/** Keep the caret from landing inside a replaced task marker. */
const atomicTasks = EditorView.atomicRanges.of((view) => {
  const ranges: Range<Decoration>[] = []
  const tree = syntaxTree(view.state)
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === 'TaskMarker') {
          ranges.push(Decoration.mark({}).range(node.from, node.to))
        }
      },
    })
  }
  return Decoration.set(ranges, true)
})

/**
 * Three extensions, and the split is forced rather than chosen.
 *
 * CodeMirror refuses block decorations from a ViewPlugin outright — "Block
 * decorations may not be specified via plugins" — because a plugin is rebuilt
 * from the viewport and block widgets change the height of lines the viewport
 * has not measured. So the image embeds live in a StateField, computed from the
 * document rather than from what is on screen.
 */
export const markdownDecorations: Extension = [plugin, atomicTasks, imageEmbeds]
