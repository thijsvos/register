import { syntaxTree } from '@codemirror/language'
import type { Extension, Range } from '@codemirror/state'
import {
  type Command,
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { IMAGE, imageEmbeds } from './media'
import { TaskToggle } from './tasks'
import { WIKILINK, wikiLinkHost } from './wikilinks'

const HEADING = new Map([
  // Setext first, so the pair is visible together: `Title` over `=====` is a
  // level-1 heading in CommonMark and `-----` a level-2 one. The grammar has
  // always reported them; nothing here asked. They take the same styles as
  // their ATX equivalents, because they are the same thing written differently
  // — and the underline itself is punctuation, so it lands in the `HeaderMark`
  // branch below and dims like a `#`.
  ['SetextHeading1', 'cm-h1'],
  ['SetextHeading2', 'cm-h2'],
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
 * A reference whose target is a file this app can show — `[text](spec.pdf)` or
 * `![alt](diagram.png)` alike.
 *
 * Only those: an ordinary link to another note, or to the web, keeps the demoted
 * ink the HighlightStyle already gives it. Marking every link would promise a
 * surface for targets there is none for.
 *
 * Built per reference rather than hoisted, because it carries its own target.
 * The alternative — recovering the target by re-running a regex over the clicked
 * line — takes the first match on that line, so two references on one line open
 * whichever came first. Written that way at first; the attribute is both simpler
 * and correct.
 */
const fileLink = (target: string) =>
  Decoration.mark({
    class: 'cm-filelink',
    attributes: { role: 'link', tabindex: '0', 'data-src': target },
  })

/**
 * A reference whose target has already failed to load.
 *
 * Dotted and dim, and carrying no `role="link"` — §02b's own vocabulary for "the
 * target is not there", the same the wikilink uses. Inert rather than dressed,
 * because a click could only open a surface saying what this already says.
 */
const fileGone = Decoration.mark({ class: 'cm-fileref-missing' })

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
            marks.push(
              (host.fileMissing(target) ? fileGone : fileLink(target)).range(
                node.from,
                node.to,
              ),
            )
          }
          return
        }
        // The reference itself, not only the image drawn beneath it. A reader
        // who wants a closer look clicks what they can see — and the text is
        // what they can see before the image has decoded.
        if (node.name === 'Image') {
          const target =
            IMAGE.exec(view.state.doc.sliceString(node.from, node.to))?.[2] ?? ''
          if (target !== '' && host.fileUrl(target) !== null) {
            marks.push(
              (host.fileMissing(target) ? fileGone : fileLink(target)).range(
                node.from,
                node.to,
              ),
            )
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

/**
 * What following the link at `at` would do, or null if there is none there.
 *
 * A thunk rather than a description, so the two callers — a key and a focused
 * mark — cannot disagree about what a wikilink means versus what a file
 * reference means. The rules are `build`'s, read the same way round: a `.md`
 * target is a note and notes are linked with `[[wikilinks]]`, and a reference
 * whose target has already proved absent is inert rather than followable.
 */
function linkAt(view: EditorView, at: number): (() => void) | null {
  const host = view.state.facet(wikiLinkHost)
  const line = view.state.doc.lineAt(at)

  // Wikilinks first, and off the text rather than the tree: they are not a
  // markdown construct, so the grammar has no node for them.
  for (const match of line.text.matchAll(WIKILINK)) {
    const start = line.from + (match.index ?? 0)
    if (at >= start && at <= start + match[0].length) {
      const target = (match[1] ?? '').trim()
      return () => host.open(target)
    }
  }

  let found: (() => void) | null = null
  syntaxTree(view.state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (found !== null) return false
      if (node.name !== 'Link' && node.name !== 'Image') return
      if (at < node.from || at > node.to) return

      const written = view.state.doc.sliceString(node.from, node.to)
      const target =
        (node.name === 'Link' ? LINK.exec(written)?.[1] : IMAGE.exec(written)?.[2]) ?? ''
      if (target === '' || /\.md$/i.test(target)) return
      if (host.fileUrl(target) === null || host.fileMissing(target)) return
      found = () => host.openFile(target)
    },
  })
  return found
}

/**
 * Follow the link the caret is in (§01: "every action reachable without a
 * mouse"; §08 P5's done-when: "full session possible without a mouse").
 *
 * §02b's state matrix draws no keyboard follow — its Focus column for these two
 * rows describes the missing-target appearance instead — so this is a binding
 * the frame does not draw, taken for the reason the INDEX entry keys were:
 * leaving it out puts a documented hole in §01's central claim. It is named in
 * ⌘K for the same reason, so the key is on screen rather than only in here.
 *
 * False when the caret is not in a link, which lets `Mod-Enter` fall through to
 * the blank-line insert it means everywhere else in the document.
 */
export const followLink: Command = (view) => {
  const follow = linkAt(view, view.state.selection.main.head)
  if (follow === null) return false
  follow()
  return true
}

/**
 * Follow the link that holds DOM focus — Enter or Space on a tabbed-to mark.
 *
 * The marks have carried `role="link"` and `tabindex="0"` since they were
 * built, which tells a screen reader they are links and puts them in the tab
 * order, and nothing answered the key that announcement promises. Measured: Tab
 * from the editor does reach them, so the attributes were true and only the
 * behaviour was missing.
 *
 * A keymap entry rather than a `keydown` in the plugin's `eventHandlers`, and
 * that is not a style preference: written the other way the editor inserted a
 * newline and this never ran. Precedence is the whole question here, and a
 * keymap is where CodeMirror lets you state it.
 *
 * False when nothing is focused but the document itself, which is every
 * ordinary keystroke — so Enter stays Enter.
 */
export const followFocusedLink: Command = (view) => {
  const focused = document.activeElement
  if (!(focused instanceof HTMLElement)) return false

  const mark = focused.closest('.cm-filelink, .cm-wiki')
  if (mark === null || !view.contentDOM.contains(mark)) return false

  const follow = linkAt(view, view.posAtDOM(mark))
  if (follow === null) return false
  follow()
  return true
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
        const written = file?.getAttribute('data-src')
        if (written !== null && written !== undefined) {
          event.preventDefault()
          view.state.facet(wikiLinkHost).openFile(written)
          return true
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
