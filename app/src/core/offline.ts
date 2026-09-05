/**
 * The export's half of the wire (§12, ADR-008).
 *
 * `register export` writes a vault and its reader into one HTML file, and the
 * file carries the vault's answers inline: the tree, every note's bytes and the
 * media the notes point at, as one JSON block the binary put there. When that
 * block is on the page there is no server — the page opened from disk — and
 * `api.ts` answers from here instead of from `fetch`. When it is absent, which
 * is every served page, `payload` is null and nothing in this module runs.
 *
 * Read once, at module load. The block is in the document before the script
 * that reads it, and a module script runs after the parser has reached the end
 * of the document anyway. Under vitest there is no document at all, so the
 * lookup is guarded rather than assumed — the tests drive the served path.
 *
 * Nothing here is validated. The shape is checked in `api.ts` at the same
 * boundary the served tree crosses, so a payload this client cannot read fails
 * the same way a server it cannot read does: with a message, not an
 * `undefined` three layers in.
 */

/** The element `src/export.rs` writes the payload into. One id, both sides. */
export const PAYLOAD_ID = 'register-export'

export interface Payload {
  /** The `GET /api/tree` envelope, as the binary computed it at export time. */
  tree: unknown
  /** Vault path → the note's bytes, exactly as read. */
  notes: Record<string, string>
  /**
   * Vault path → a `data:` URL, for every image and PDF the export carries.
   *
   * Absent for a file that was not carried, which is what `--media none` and a
   * file the vault refused to serve both come to: the reference is drawn as
   * §02b Screen 8 draws a missing target, dotted and inert.
   */
  files: Record<string, string>
  /** When it was written, ISO-8601 UTC. What the status bar shows instead of the watcher. */
  stamp: string
}

function read(): Payload | null {
  if (typeof document === 'undefined') return null
  const block = document.getElementById(PAYLOAD_ID)
  if (block === null) return null
  const parsed: unknown = JSON.parse(block.textContent ?? 'null')
  if (typeof parsed !== 'object' || parsed === null) return null
  const raw = parsed as Record<string, unknown>
  return {
    tree: raw.tree,
    notes: asStrings(raw.notes),
    files: asStrings(raw.files),
    stamp: typeof raw.stamp === 'string' ? raw.stamp : '',
  }
}

function asStrings(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (pair): pair is [string, string] => typeof pair[1] === 'string',
    ),
  )
}

export const payload: Payload | null = read()

/** Whether this page is an export: read-only, offline, and says so. */
export const offline = payload !== null

/**
 * What every write says when it is asked for in an export.
 *
 * §02's voice: what happened, then the fix. The fix is the served app, which is
 * the only thing that can reach the vault the export was cut from.
 */
export const READ_ONLY = 'An export is read-only. Open the vault in REGISTER to write.'
