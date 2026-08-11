/**
 * The INDEX as a folder tree (§02b Screen 1, Rev N).
 *
 * The pane was a flat list sorted by path, which reads as a numbered register
 * only while every note is one level down. Nesting has always worked — a note
 * three folders deep is indexed, searched, tag-counted and resolves as a
 * backlink — but nothing drew it, so a vault with structure looked like a vault
 * with a shuffled list.
 *
 * Mirrors the filesystem with no special cases: `notes/` is a folder like any
 * other. Membership is still `isListed`, so the agent contract, the stencils and
 * the journal stay out — folders are a way to show what the index contains, not
 * a decision to change what it contains.
 *
 * Pure, and importing nothing but a type: the sidebar rebuilds this on every
 * tree change, which happens on every agent write, and §06 budgets a keystroke
 * at 16 ms.
 */
import type { Entry } from './api'
import { inside, isListed } from './paths'

export interface Folder {
  kind: 'folder'
  /** Full path from the vault root — the key collapse state is stored under. */
  path: string
  /** What the row reads. A chain of single-child folders is joined with `/`. */
  label: string
  children: Node[]
  /** Notes beneath this folder at any depth. */
  count: number
}

export interface Note {
  kind: 'note'
  path: string
  entry: Entry
}

export type Node = Folder | Note

interface Building {
  folders: Map<string, Building>
  notes: Entry[]
}

const empty = (): Building => ({ folders: new Map(), notes: [] })

/**
 * Group entries by their directories, deepest first, into display order.
 *
 * Folders before notes and each alphabetical, which is what every file tree the
 * reader has ever used does — and the reason this exists at all is that a flat
 * list stops working at scale, so matching the convention people already have is
 * most of the value.
 */
export function folderTree(entries: Entry[]): Node[] {
  const root = empty()

  for (const entry of entries) {
    const segments = entry.path.split('/')
    const file = segments.pop()
    if (file === undefined || file === '') continue

    let here = root
    for (const segment of segments) {
      // Not `??=`: an empty folder name would key the map on '' and swallow
      // every sibling into one node. Paths like `a//b.md` do not come from this
      // app, but a vault is a folder anyone can write to.
      if (segment === '') continue
      let next = here.folders.get(segment)
      if (next === undefined) {
        next = empty()
        here.folders.set(segment, next)
      }
      here = next
    }
    here.notes.push(entry)
  }

  return level(root, '')
}

function level(node: Building, prefix: string): Node[] {
  const folders: Folder[] = []

  for (const [name, child] of node.folders) {
    let path = prefix === '' ? name : `${prefix}/${name}`
    let label = name
    let here = child

    // Compact a chain of folders that only ever contains one folder:
    // `notes/projects/apollo` holding a single note is one row, not three
    // nested ones. Indentation is the scarcest thing in a 250px rail, and a
    // level that offers no choice is a level not worth spending it on.
    while (here.notes.length === 0 && here.folders.size === 1) {
      const [onlyName, onlyChild] = [...here.folders][0] as [string, Building]
      path = `${path}/${onlyName}`
      label = `${label}/${onlyName}`
      here = onlyChild
    }

    folders.push({
      kind: 'folder',
      path,
      label,
      children: level(here, path),
      count: countNotes(here),
    })
  }

  folders.sort((a, b) => a.label.localeCompare(b.label))

  const notes: Note[] = node.notes
    .map((entry) => ({ kind: 'note', path: entry.path, entry }) as const)
    .sort((a, b) => a.path.localeCompare(b.path))

  return [...folders, ...notes]
}

function countNotes(node: Building): number {
  let total = node.notes.length
  for (const child of node.folders.values()) total += countNotes(child)
  return total
}

/**
 * Every folder on the way to `path`, outermost first.
 *
 * Used to reveal the open note: a note you cannot see in the index is a note the
 * index is not doing its job for, and that includes one hidden behind a folder
 * you collapsed three sessions ago.
 */
export function ancestors(path: string): string[] {
  const segments = path.split('/').filter((segment) => segment !== '')
  segments.pop()
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}

/**
 * How many notes the INDEX draws under a folder — what a delete confirm counts.
 *
 * Listed notes only, because that is what the reader can see and therefore what
 * they are agreeing to. Whatever else is in the folder goes too, and the server
 * says so afterwards.
 *
 * Here rather than beside the commands that use it: the palette and the index's
 * `⌫` both need it, and `nav.ts` importing it from `Palette/commands.ts` — which
 * imports `nav.ts` — is an import cycle that happens to work today.
 */
export function notesUnder(entries: Entry[], folder: string): number {
  return entries.filter((entry) => isListed(entry.path) && inside(entry.path, folder))
    .length
}
