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
  /** Character offset of the opening `#` in the whole note, frontmatter included. */
  from: number
}

/**
 * ATX headings only, and only with a space after the hashes.
 *
 * The space is CommonMark's rule and it is load-bearing here: `#design` on its
 * own line is a hashtag, not a level-1 heading, and a vault full of tags would
 * otherwise produce an outline of nonsense. Setext (`===` underlines) is left
 * out because the editor does not style it as a heading either — the pane and
 * the page have to agree about what a heading is.
 */
const ATX = /^(#{1,6})(?:[ \t]+(.*))?$/

export function outline(source: string): Heading[] {
  const out: Heading[] = []

  for (const line of bodyLines(source)) {
    if (line.fenced) continue
    const heading = ATX.exec(line.text)
    if (heading === null) continue

    // A closing sequence is decoration, not content: `## Title ##` is "Title".
    const text = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim()
    // `###` alone is a valid empty heading with nothing to put in a list.
    if (text === '') continue

    out.push({ level: (heading[1] ?? '').length, text, from: line.from })
  }

  return out
}
