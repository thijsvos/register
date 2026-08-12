import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

/**
 * Every value here is a token or a calc() over tokens — hard rule 2 applies
 * inside the editor exactly as it does in the frame.
 *
 * This works because style-mod, which CodeMirror uses to build its stylesheet,
 * never parses or rewrites a declaration *value*; it only kebab-cases the
 * property name. So `var(--fg)` reaches the sheet verbatim and resolves at paint
 * time against whatever `:root` or `html.dark` is in force. One theme covers
 * both schemes and no `{ dark: true }` variant is needed.
 */
const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--fg)',
    backgroundColor: 'transparent',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--text-body)',
  },

  // The visible focus affordance belongs to the frame, not to the editable box.
  '&.cm-focused': { outline: 'none' },

  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: 'var(--lh-body)',
    overflow: 'auto',
  },

  // §02: prose is never full-bleed.
  '.cm-content': {
    maxWidth: 'var(--measure)',
    margin: '0 auto',
    padding: 'var(--s6) var(--s5)',
    caretColor: 'var(--signal)',
  },
  '.cm-line': { padding: '0' },

  // §02b Input: "signal caret, no box".
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--signal)',
    borderLeftWidth: 'var(--hairline)',
  },
  // Belt and braces against whatever CodeMirror's base theme ships.
  '.cm-cursorLayer': { animation: 'none' },

  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--sel-bg)',
    color: 'var(--sel-fg)',
  },

  // Headings. The §02 scale runs from --text-body to --text-title; the
  // intermediate levels interpolate rather than inventing new sizes.
  '.cm-h1': { fontSize: 'var(--text-title)', fontWeight: '700', color: 'var(--hi)' },
  '.cm-h2': {
    fontSize: 'calc(var(--text-body) + (var(--text-title) - var(--text-body)) * 0.62)',
    fontWeight: '700',
    color: 'var(--hi)',
  },
  '.cm-h3': {
    fontSize: 'calc(var(--text-body) + (var(--text-title) - var(--text-body)) * 0.34)',
    fontWeight: '700',
    color: 'var(--hi)',
  },
  '.cm-h4, .cm-h5, .cm-h6': {
    fontSize: 'var(--text-body)',
    fontWeight: '700',
    color: 'var(--hi)',
  },
  // The `#` markers stay visible — markdown is the literal source — but demoted.
  '.cm-hash': { color: 'var(--faint)' },

  // §02: inline code and fences are boxed with a hairline. No fill, no radius.
  '.cm-inline-code': {
    border: 'var(--hairline) solid var(--line)',
    padding: '0 var(--s1)',
  },
  '.cm-fenced-code': {
    borderLeft: 'var(--hairline) solid var(--line)',
    paddingLeft: 'var(--s3)',
  },

  // §02b Wikilink: dashed underline; dotted and dim when the target is missing.
  '.cm-wiki': {
    textDecoration: 'underline',
    textDecorationStyle: 'dashed',
    textUnderlineOffset: 'var(--underline-gap)',
    cursor: 'pointer',
  },
  '.cm-wiki-missing': {
    textDecorationStyle: 'dotted',
    color: 'var(--dim)',
  },

  // A link whose target is a file this app can show. The same dashed underline
  // a wikilink gets, because it is the same promise: this opens something.
  '.cm-filelink': {
    textDecoration: 'underline',
    textDecorationStyle: 'dashed',
    textUnderlineOffset: 'var(--underline-gap)',
    cursor: 'pointer',
  },

  // A reference whose target proved absent. §02b's own words for it, borrowed
  // from the wikilink: dotted and dim. No pointer — there is nothing to open.
  '.cm-fileref-missing': {
    textDecoration: 'underline',
    textDecorationStyle: 'dotted',
    textUnderlineOffset: 'var(--underline-gap)',
    color: 'var(--dim)',
  },

  // §02b Task: `[ ]` fg, `[x]` plus dim strikethrough on the text.
  '.cm-task-toggle': {
    display: 'inline-block',
    width: 'var(--s4)',
    height: 'var(--s4)',
    lineHeight: 'var(--s4)',
    textAlign: 'center',
    border: 'var(--hairline) solid var(--line)',
    // §02b state matrix, Task / todo, hover: "box cursor". Not a pointer — the
    // same control in the TODAY aggregate has to feel like the same control.
    cursor: 'cell',
    userSelect: 'none',
    verticalAlign: 'text-bottom',
  },
  '.cm-task-toggle:focus-visible': {
    outline: 'var(--hairline) dashed var(--fg)',
    outlineOffset: 'var(--focus-offset)',
  },
  '.cm-task-done': { color: 'var(--dim)', textDecoration: 'line-through' },

  // The image under its own `![alt](src)`. §02 allows exactly one kind of
  // chrome — a 1px hairline — so the frame is a rule and nothing else: no
  // radius, no shadow, no caption plate, and no transition as it decodes.
  // **No margin on this element, ever.** CodeMirror measures a block widget by
  // its border box, and a margin sits outside that — so the height map ends up
  // short by exactly the margin and every coordinate below the image maps to the
  // wrong document position. Measured: `var(--s3) 0` is 24px against a 21px
  // line, so a click below one image landed a line out, below two images two
  // lines out. The gap is padding on this wrapper instead, and the rule that
  // draws the box moved inside it.
  '.cm-embed': {
    display: 'block',
    padding: 'var(--s3) 0',
    cursor: 'pointer',
  },
  '.cm-embed-box': {
    padding: 'var(--s2)',
    border: 'var(--hairline) solid var(--line)',
  },
  '.cm-embed-image': {
    display: 'block',
    // Never wider than the prose it sits in: §02's measure is the column, and
    // an image that broke it would be the only full-bleed thing on the page.
    maxWidth: '100%',
    height: 'auto',
  },
  // The wikilink's own "target is not there" idiom, reused rather than invented.
  '.cm-embed-missing': {
    color: 'var(--dim)',
  },
  '.cm-embed-missing .cm-embed-box': {
    borderStyle: 'dotted',
  },
  '.cm-embed-said': {
    fontFamily: 'var(--font-micro)',
    fontSize: 'var(--text-micro)',
    letterSpacing: 'var(--track-micro)',
    textTransform: 'uppercase',
    color: 'var(--dim)',
  },
})

/**
 * Syntax highlighting. Monochrome by construction: weight and one demoted ink
 * are the only variables, because §02 permits exactly one accent and reserves it
 * for live status.
 */
const highlight = HighlightStyle.define([
  { tag: tags.strong, fontWeight: '700', color: 'var(--hi)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--dim)' },
  { tag: tags.link, color: 'var(--dim)' },
  { tag: tags.url, color: 'var(--dim)' },
  { tag: tags.quote, color: 'var(--dim)' },
  { tag: tags.monospace, color: 'var(--fg)' },
  { tag: tags.meta, color: 'var(--faint)' },
  { tag: tags.processingInstruction, color: 'var(--faint)' },
])

export const editorTheme: Extension = [theme, syntaxHighlighting(highlight)]
