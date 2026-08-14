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

/**
 * Where the prose starts — the offset just past the closing fence.
 *
 * The caret lands here when a note is opened. At offset 0 it sits *before* the
 * opening `---`, and the first thing anyone types pushes the fence off byte
 * zero: `split` then finds no frontmatter, `touchModified` becomes a no-op, and
 * the server can no longer read the note's title, ref or tags. A note loses its
 * identity because someone opened it and started typing.
 */
export function bodyOffset(source: string): number {
  return source.length - split(source).body.length
}

/** Whether the source carries a frontmatter block at all. */
export function hasFrontmatter(source: string): boolean {
  return split(source).open !== ''
}

/**
 * Replace one frontmatter value, or append the field if it is missing.
 *
 * A splice, so key order, indentation, quoting style, comments and the body all
 * survive byte for byte — which is what lets an agent and a human edit the same
 * file without churning each other's formatting. A note without frontmatter is
 * returned untouched: §04 says what a note looks like, and inventing a header
 * for a file that has none is a bigger decision than setting a field.
 */
export function setField(source: string, key: string, value: string): string {
  const parts = split(source)
  if (parts.open === '') return source

  // Anchored to column zero on purpose. Allowing leading whitespace would also
  // match a key nested inside another mapping, or a line of prose inside a block
  // scalar — and since the replace is first-match-wins it would rewrite that one
  // and leave the real field stale. Both are §04 byte-losslessness breaches, and
  // both destroy data an agent wrote.
  const pattern = new RegExp(`^(${literal(key)}[ \\t]*:[ \\t]*)(.*)$`, 'm')
  if (pattern.test(parts.yaml)) {
    // A function replacement, not a `$1${value}` string: in a replacement string
    // `$` is syntax, so a title like "Cost in $1 terms" would splice the matched
    // key back into its own value.
    return join({
      ...parts,
      yaml: parts.yaml.replace(pattern, (_match, head: string) => head + value),
    })
  }

  const eol = parts.yaml.endsWith('\r\n') ? '\r\n' : '\n'
  const separator = parts.yaml === '' || parts.yaml.endsWith('\n') ? '' : eol
  return join({ ...parts, yaml: `${parts.yaml}${separator}${key}: ${value}${eol}` })
}

/**
 * Stamp `modified:` — the one field the UI rewrites on an ordinary save (§04).
 */
export function touchModified(source: string, iso: string): string {
  return setField(source, 'modified', iso)
}

/** A key matched as text, not as a pattern. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The frontmatter as flat key/value pairs.
 *
 * Deliberately not a YAML parser: §04's frontmatter is a flat map of scalars
 * plus one inline sequence, the server owns real parsing, and pulling a YAML
 * library into the shell would spend the §06 budget on re-deriving what
 * `/api/tree` already sends. Anything it cannot read it simply omits.
 */
const FIELD = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*?)[ \t]*\r?\n?$/

/**
 * The fields exactly as they are written, quotes and all.
 *
 * What the PROPERTIES pane edits. A pane that showed the *unquoted* value and
 * wrote back what you typed would silently strip the quotes off
 * `title: "Costs: a study"` and leave a line whose colon reads as a second
 * mapping — so the editable view is the literal one, which is the same rule the
 * body follows.
 */
export function rawFields(source: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of lines(split(source).yaml)) {
    const match = FIELD.exec(line)
    if (match?.[1] !== undefined) out.set(match[1], match[2] ?? '')
  }
  return out
}

export function fields(source: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of rawFields(source)) out.set(key, unquote(value))
  return out
}

/**
 * Whether the block can be taken off the screen without losing anything.
 *
 * The editor hides §04's frontmatter and the inspector edits it instead, so the
 * question is not "does this parse" but "can that pane show and rewrite every
 * byte of it". Two ways the answer is no, and each would hide something the
 * reader could then neither see nor repair:
 *
 *   - a line no parser reads. `fields` omits what it cannot parse, which is
 *     right for a reader and wrong here: the dropped line is precisely the one
 *     somebody needs to look at.
 *   - the same key twice. The pane is a map and would draw one row; `setField`
 *     rewrites the first match. So the row shown and the line written could be
 *     different lines, which is a way to lose an agent's work silently.
 *
 * False for a note with no frontmatter at all — nothing to hide, which is a
 * different answer from "the block is fine" and the caller needs both.
 */
export function canHideFrontmatter(source: string): boolean {
  const parts = split(source)
  if (parts.open === '') return false

  const seen = new Set<string>()
  for (const line of lines(parts.yaml)) {
    if (line.trim() === '') continue
    const match = FIELD.exec(line)
    if (match?.[1] === undefined) return false
    if (seen.has(match[1])) return false
    seen.add(match[1])
  }
  return true
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
/**
 * Characters in the body, ignoring frontmatter — the other half of §08 P4's
 * "Words/chars + RENDER ms live".
 *
 * Code units rather than code points. `[...body].length` would count an emoji
 * once instead of twice, and it allocates an array of every character in the
 * note on every keystroke — the cost `wordCount` above exists to avoid, for a
 * difference nothing in a plain-text vault is likely to notice.
 */
export function charCount(source: string): number {
  return split(source).body.length
}

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
