/**
 * Frontmatter handling, byte-preserving.
 *
 * §04's compatibility contract: "round-trip through the UI is byte-lossless
 * outside frontmatter `modified`". That rules out parse-then-re-serialize —
 * a YAML emitter re-quotes strings, reorders nothing predictably, and rewrites
 * whitespace, so every save would rewrite a file an agent had just formatted.
 * These functions splice instead: they locate one line and leave every other
 * byte untouched.
 */

/** A note cut into pieces that concatenate back to the exact original. */
export interface Split {
  /** `﻿` if the file had a byte-order mark, otherwise empty. */
  bom: string
  /** The opening `---` line, including its line ending. Empty if no frontmatter. */
  open: string
  /** The YAML between the fences, verbatim, including its trailing newline. */
  yaml: string
  /** The closing `---` line, including its line ending. Empty if no frontmatter. */
  close: string
  /** Everything after the closing fence. */
  body: string
}

const FENCE = /^---[ \t]*\r?\n/

export function split(source: string): Split {
  const bom = source.startsWith('﻿') ? '﻿' : ''
  const rest = source.slice(bom.length)

  const opening = FENCE.exec(rest)
  if (opening?.index !== 0) {
    return { bom, open: '', yaml: '', close: '', body: rest }
  }
  const open = opening[0]
  const afterOpen = rest.slice(open.length)

  // Scan line by line for the closing fence rather than searching for "\n---",
  // which would match `---` appearing mid-document or a longer rule.
  let offset = 0
  for (const line of lines(afterOpen)) {
    if (/^---[ \t]*\r?\n?$/.test(line)) {
      return {
        bom,
        open,
        yaml: afterOpen.slice(0, offset),
        close: line,
        body: afterOpen.slice(offset + line.length),
      }
    }
    offset += line.length
  }
  // An unterminated fence is not frontmatter.
  return { bom, open: '', yaml: '', close: '', body: rest }
}

export function join(parts: Split): string {
  return parts.bom + parts.open + parts.yaml + parts.close + parts.body
}

/** Whether the source carries a frontmatter block at all. */
export function hasFrontmatter(source: string): boolean {
  return split(source).open !== ''
}

/**
 * Replace the `modified:` value, or add the field if it is missing.
 *
 * The only field the UI is allowed to rewrite (§04). Everything else — key
 * order, indentation, quoting style, comments, the body — survives byte for
 * byte, which is what lets an agent and a human edit the same file without
 * churning each other's formatting.
 */
export function touchModified(source: string, iso: string): string {
  const parts = split(source)
  if (parts.open === '') return source

  // Anchored to column zero on purpose. Allowing leading whitespace would also
  // match `modified:` nested inside another mapping, or a line of prose inside a
  // block scalar — and since the replace is first-match-wins it would rewrite
  // that one and leave the real field stale. Both are §04 byte-losslessness
  // breaches, and both destroy data an agent wrote.
  const pattern = /^(modified[ \t]*:[ \t]*)(.*)$/m
  if (pattern.test(parts.yaml)) {
    return join({ ...parts, yaml: parts.yaml.replace(pattern, `$1${iso}`) })
  }

  const eol = parts.yaml.endsWith('\r\n') ? '\r\n' : '\n'
  const separator = parts.yaml === '' || parts.yaml.endsWith('\n') ? '' : eol
  return join({ ...parts, yaml: `${parts.yaml}${separator}modified: ${iso}${eol}` })
}

/**
 * The frontmatter as flat key/value pairs.
 *
 * Deliberately not a YAML parser: §04's frontmatter is a flat map of scalars
 * plus one inline sequence, the server owns real parsing, and pulling a YAML
 * library into the shell would spend the §06 budget on re-deriving what
 * `/api/tree` already sends. Anything it cannot read it simply omits.
 */
export function fields(source: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of lines(split(source).yaml)) {
    const match = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*?)[ \t]*\r?\n?$/.exec(line)
    if (match?.[1] !== undefined) out.set(match[1], unquote(match[2] ?? ''))
  }
  return out
}

/** `[design, research]` or `design, research` → `['design', 'research']`. */
export function list(value: string | undefined): string[] {
  if (!value) return []
  return value
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((item) => unquote(item.trim()))
    .filter((item) => item !== '')
}

/**
 * Words in the body, ignoring frontmatter.
 *
 * Scanned rather than split: this runs on every keystroke to feed the status
 * bar, and `split(/\s+/)` would allocate an array of every word in the note each
 * time — five thousand strings per character typed on a long note.
 */
export function wordCount(source: string): number {
  const body = split(source).body
  let words = 0
  let inside = false
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i)
    const space = code === 32 || (code >= 9 && code <= 13) || code === 0xa0
    if (space) {
      inside = false
    } else if (!inside) {
      inside = true
      words++
    }
  }
  return words
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value)
  return quoted?.[1] ?? value
}

/** Split keeping line endings attached, so offsets stay byte-exact. */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? []
}
