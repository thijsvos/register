/**
 * The heading outline of a note, for the inspector's OUTLINE pane.
 *
 * Derived from the live buffer rather than from the corpus, so a heading appears
 * in the pane as it is typed. Offsets are character offsets into the same string
 * the editor holds, which is what makes a row clickable: the pane hands one
 * straight back to CodeMirror.
 */
import { split } from './frontmatter'

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
/** An opening or closing code fence, up to three spaces of indent. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

export function outline(source: string): Heading[] {
  const parts = split(source)
  // Everything before the body: BOM, both fences and the YAML between them.
  const base = source.length - parts.body.length

  const out: Heading[] = []
  let fence: string | null = null
  let at = 0

  for (const raw of parts.body.split('\n')) {
    // Offsets stay byte-exact whatever the line ending, because `raw` keeps its
    // carriage return and only the copy used for matching loses it.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const rule = FENCE.exec(line)

    if (fence !== null) {
      // A fence closes on the same character, at least as long, and with nothing
      // after it — a line carrying an info string is content, not a closer.
      const marks = rule?.[1] ?? ''
      if (
        rule !== null &&
        marks.startsWith(fence[0] ?? '') &&
        marks.length >= fence.length &&
        (rule[2] ?? '').trim() === ''
      ) {
        fence = null
      }
    } else if (rule !== null) {
      fence = rule[1] ?? ''
    } else {
      const heading = ATX.exec(line)
      // A closing sequence is decoration, not content: `## Title ##` is "Title".
      const text = (heading?.[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim()
      // `###` alone is a valid empty heading with nothing to put in a list.
      if (heading !== null && text !== '') {
        out.push({ level: (heading[1] ?? '').length, text, from: base + at })
      }
    }

    at += raw.length + 1
  }

  return out
}
