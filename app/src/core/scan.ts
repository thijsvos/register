/**
 * Reading a note body line by line, with code fences accounted for.
 *
 * Shared because the outline and the task list have to agree about what a fenced
 * block is. Two scanners would drift, and the drift would be silent: a `# note`
 * in a shell snippet becoming a heading, or a `- [ ]` in a code sample becoming
 * something the vault says you have to do.
 */
import { split } from './frontmatter'

export interface Line {
  /** The line's text, without its terminator or a trailing carriage return. */
  text: string
  /** Character offset of the line's first character in the whole note. */
  from: number
  /** Inside a fenced code block — the opening and closing fences included. */
  fenced: boolean
}

/** An opening or closing code fence, up to three spaces of indent. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/**
 * Every line of the body, frontmatter excluded but still counted in `from`, so
 * an offset can be handed straight to the editor or spliced back into the file.
 */
export function bodyLines(source: string): Line[] {
  const parts = split(source)
  // Everything before the body: BOM, both fences and the YAML between them.
  const base = source.length - parts.body.length

  const out: Line[] = []
  let fence: string | null = null
  let at = 0

  for (const raw of parts.body.split('\n')) {
    // Offsets stay byte-exact whatever the line ending, because `raw` keeps its
    // carriage return and only the copy reported loses it.
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const rule = FENCE.exec(text)
    let fenced = fence !== null

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
      fenced = true
    }

    out.push({ text, from: base + at, fenced })
    at += raw.length + 1
  }

  return out
}
