/**
 * The heading outline of a note, for the inspector's OUTLINE pane.
 *
 * Derived from the live buffer rather than from the corpus, so a heading appears
 * in the pane as it is typed. Offsets are character offsets into the same string
 * the editor holds, which is what makes a row clickable: the pane hands one
 * straight back to CodeMirror.
 */
import { bodyLines } from './scan'

export interface Heading {
  /** 1–6. */
  level: number
  /** The heading text, markdown left literal (§02: the source is the source). */
  text: string
  /**
   * Character offset of the heading's first character in the whole note,
   * frontmatter included — the `#` for an ATX heading, and the text itself for
   * a setext one, which has no marker to point at.
   */
  from: number
}

/**
 * ATX headings, and only with a space after the hashes.
 *
 * The space is CommonMark's rule and it is load-bearing here: `#design` on its
 * own line is a hashtag, not a level-1 heading, and a vault full of tags would
 * otherwise produce an outline of nonsense.
 */
const ATX = /^(#{1,6})(?:[ \t]+(.*))?$/

/**
 * A setext underline: `=====` for level 1, `-----` for level 2.
 *
 * Up to three spaces of indent and trailing whitespace, both CommonMark's. This
 * pane and the editor have to agree about what a heading is, and the editor
 * styles these now, so the pane lists them.
 */
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/

/**
 * Lines that cannot be the *content* of a setext heading.
 *
 * CommonMark says the content is a paragraph, which rules out a list item, a
 * quote and a heading. It matters most for `-`: a `---` under a paragraph is a
 * level-2 heading, and the same three characters under a blank line or a list
 * are a thematic break. Getting this wrong turns every horizontal rule in the
 * vault into an outline entry.
 */
const NOT_A_PARAGRAPH = /^ {0,3}(?:[-*+>]|\d+[.)])(?:[ \t]|$)/

export function outline(source: string): Heading[] {
  const out: Heading[] = []
  const lines = bodyLines(source)

  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]
    if (line === undefined || line.fenced) continue

    const heading = ATX.exec(line.text)
    if (heading !== null) {
      // A closing sequence is decoration, not content: `## Title ##` is "Title".
      const text = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim()
      // `###` alone is a valid empty heading with nothing to put in a list.
      if (text === '') continue
      out.push({ level: (heading[1] ?? '').length, text, from: line.from })
      continue
    }

    // Setext: this line is the text and the next one underlines it. Read
    // forwards rather than remembering the previous line, so the offset
    // reported is the content's — which is where a reader clicking the row
    // expects to land, there being no `#` to point at.
    const under = lines[at + 1]
    if (under === undefined || under.fenced) continue
    const rule = SETEXT.exec(under.text)
    if (rule === null) continue

    const text = line.text.trim()
    if (text === '' || NOT_A_PARAGRAPH.test(line.text)) continue

    out.push({ level: (rule[1] ?? '').startsWith('=') ? 1 : 2, text, from: line.from })
    // The underline is spoken for. Without this a `=====` line would go on to
    // be considered the content of whatever underlines *it*.
    at++
  }

  return out
}
