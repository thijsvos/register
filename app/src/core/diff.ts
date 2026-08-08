/**
 * A line-level diff, in the shape §02b Screen 4 draws.
 *
 * The frame is two columns with a gutter mark per line — `=` where the sides
 * agree, `−`/`+` where they do not — so that is exactly what a row is here. A
 * side with no line at that point is `null`, which the frame draws as `∅ (empty)`
 * and which is a real choice rather than an absence: picking it means the line is
 * not in the merge.
 *
 * Deliberately not `editor/sync.ts`'s `minimalChange`. That one is a character
 * prefix/suffix scan, which is the wrong shape for a per-line picker — and it
 * lives in the lazy editor chunk, which the shell may not import. `core/` pulls
 * nothing from `editor/`; that is the mistake P6 made and `doctrine.test.ts` now
 * bans.
 */

export type Side = 'local' | 'disk'

export interface Row {
  /** `same` when both sides carry this line, so there is nothing to choose. */
  kind: 'same' | 'change'
  /** The line on the left, or null where that side has none. */
  local: string | null
  /** The line on the right, or null where that side has none. */
  disk: string | null
}

/**
 * Above this many table cells, stop trying to be minimal and pair the two sides
 * line by line instead.
 *
 * The table is quadratic, and the alternative to a bound is a tab that stops
 * responding on a note nobody thought about. A still-honest diff beats a
 * minimal one that never renders — and after the prefix and suffix are trimmed,
 * reaching this needs ~2000 changed lines on *both* sides of one note.
 */
const MAX_CELLS = 4_000_000

/**
 * Pair two revisions of a note, line by line.
 *
 * Splitting on `\n` keeps a trailing newline as a final empty line, so joining
 * the rows back together reproduces the file byte for byte — which is what makes
 * `merge` a round trip rather than an approximation.
 */
export function diffLines(local: string, disk: string): Row[] {
  const a = local.split('\n')
  const b = disk.split('\n')

  // Common prefix and suffix first. An agent rewrites a paragraph, not a note,
  // so trimming what already agrees is what keeps the table small enough to be
  // worth building at all.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++

  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const rows: Row[] = []
  for (let i = 0; i < head; i++) rows.push(agreed(a[i] ?? ''))
  rows.push(...align(a.slice(head, a.length - tail), b.slice(head, b.length - tail)))
  for (let i = a.length - tail; i < a.length; i++) rows.push(agreed(a[i] ?? ''))
  return rows
}

/** How many rows still need a side. The frame's `[ all lines chosen ]` gate. */
export function pending(
  rows: readonly Row[],
  chosen: readonly (Side | undefined)[],
): number {
  let count = 0
  for (const [at, row] of rows.entries()) {
    if (row.kind === 'change' && chosen[at] === undefined) count++
  }
  return count
}

/**
 * The merged note, or null while any row is still unchosen.
 *
 * Null rather than a default side: the frame draws a gate, not a preselection,
 * and quietly resolving a line the user has not looked at is how a merge tool
 * loses somebody's writing.
 */
export function merge(
  rows: readonly Row[],
  chosen: readonly (Side | undefined)[],
): string | null {
  if (pending(rows, chosen) > 0) return null

  const out: string[] = []
  for (const [at, row] of rows.entries()) {
    const line = row.kind === 'same' || chosen[at] === 'local' ? row.local : row.disk
    // A null side is a chosen absence — the line is simply not in the merge.
    if (line !== null) out.push(line)
  }
  return out.join('\n')
}

function agreed(text: string): Row {
  return { kind: 'same', local: text, disk: text }
}

/** Pair the parts that do not already agree, minimally where that is affordable. */
function align(a: string[], b: string[]): Row[] {
  if (a.length === 0 && b.length === 0) return []
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_CELLS) {
    return zip(a, b)
  }

  // Longest common subsequence, filled from the end so the walk below can read
  // it forwards and keep the rows in file order.
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  const cell = (i: number, j: number): number => table[i * width + j] ?? 0

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1))
    }
  }

  const rows: Row[] = []
  let held: string[] = []
  let incoming: string[] = []
  const flush = () => {
    if (held.length > 0 || incoming.length > 0) rows.push(...zip(held, incoming))
    held = []
    incoming = []
  }

  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      // A run of differences ends here, so it becomes rows before this one does.
      flush()
      rows.push(agreed(a[i] ?? ''))
      i++
      j++
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      held.push(a[i] ?? '')
      i++
    } else {
      incoming.push(b[j] ?? '')
      j++
    }
  }
  while (i < a.length) held.push(a[i++] ?? '')
  while (j < b.length) incoming.push(b[j++] ?? '')
  flush()

  return rows
}

/** Lay a run of local-only lines beside a run of disk-only ones, padding with null. */
function zip(local: readonly string[], disk: readonly string[]): Row[] {
  const rows: Row[] = []
  for (let at = 0; at < Math.max(local.length, disk.length); at++) {
    rows.push({
      kind: 'change',
      local: at < local.length ? (local[at] ?? '') : null,
      disk: at < disk.length ? (disk[at] ?? '') : null,
    })
  }
  return rows
}
