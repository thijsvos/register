import { revealVault } from '../../core/api'
import { rewrites } from '../../core/move'
import { folders, isListed, isTemplate, splitFolder } from '../../core/paths'
import { vault } from '../../core/store.svelte'
import { folderTargets, notesUnder } from '../../core/tree'
import { enterIndex, go } from '../nav'
import { chrome } from '../view.svelte'

/**
 * One palette entry. §01: "every control shows its key" — so `keys` is not
 * optional decoration, it is part of what a command is.
 */
export interface Command {
  id: string
  label: string
  /** Rendered right-aligned in the palette. Empty when there is no binding. */
  keys: string
  /**
   * What it does, given whatever is in the box.
   *
   * The query is passed because NEW · NOTE names the note after it — see below.
   * Every other command ignores the argument.
   */
  run: (query: string) => void | Promise<void>
  /**
   * Dim text after the label, when the command has something to say about what
   * it is about to do. Only NEW · NOTE uses it, and only once a title is typed.
   */
  detail?: string
  /**
   * The query is this command's *argument*, not a filter over it.
   *
   * Such a command is exempt from the fuzzy match, for the reason
   * `templateChoices` already is: `Launch plan` does not match `NEW · NOTE` and
   * `MOVE archive` does not match `MOVE · NOTE`, so the one row that could act
   * on what had been typed was the row that disappeared while it was typed.
   * Exempt is not the same as first — an exact match still sorts above it.
   */
  takesQuery?: boolean
  /** Hidden when it cannot do anything, rather than shown and inert. */
  enabled?: () => boolean
  /**
   * This command puts focus somewhere itself.
   *
   * The palette restores focus to wherever it came from when it closes, which is
   * right for a command that only changes state and wrong for one whose entire
   * effect is where the focus lands — the restore would undo it a microtask later
   * and the command would look dead.
   */
  takesFocus?: boolean
}

export function allCommands(): Command[] {
  return [
    {
      id: 'new',
      label: 'NEW · NOTE',
      keys: 'N',
      takesQuery: true,
      // The query is the title, and the folder, exactly as NEW FROM TEMPLATE
      // already reads them. Throwing it away meant a titled note could only be
      // made from a stencil — so a vault whose `templates/` had been emptied
      // could create nothing but `Untitled note`, with the title the user had
      // just typed sitting in the box above the row.
      run: (query: string) => {
        const { folder, title } = splitFolder(query)
        go.create(title === '' ? UNTITLED : title, undefined, folder ?? undefined)
      },
    },
    // §02b Screen 2 drew this row with [⌘D] against it and §08 P7 gave ⌘D to
    // the daily log. Both were normative; Rev T settled it on P7's side, so the
    // keys below are swapped from what shipped for four months.
    {
      id: 'today',
      label: 'GO · TODAY / TASKS',
      keys: 'G T',
      run: () => go.today(),
    },
    {
      id: 'daily',
      label: 'GO · DAILY LOG',
      keys: '⌘D',
      run: () => go.daily(),
    },
    // §02b Screens 9 and 10. No keys: the frame draws none against them, and a
    // binding nothing on screen names is a binding only its author knows about.
    {
      id: 'trash',
      label: 'GO · TRASH',
      keys: '',
      run: () => go.trash(),
    },
    {
      id: 'attachments',
      label: 'GO · ATTACHMENTS',
      keys: '',
      run: () => go.attachments(),
    },
    {
      id: 'inbox',
      label: 'GO · INBOX',
      keys: 'G I',
      run: () => go.follow('000'),
    },
    // §02b Screen 6 draws no key against it, so it shows none.
    {
      id: 'settings',
      label: 'GO · SETTINGS / BYOF',
      keys: '',
      run: () => go.settings(),
    },
    {
      id: 'invert',
      label: 'INVERT DISPLAY / LIGHT & DARK',
      keys: 'I',
      run: () => chrome.invert(),
    },
    {
      id: 'inspector',
      label: 'TOGGLE INSPECTOR',
      keys: ']',
      run: () => chrome.toggleInspector(),
    },
    {
      id: 'index',
      label: 'TOGGLE INDEX',
      keys: '[',
      run: () => chrome.toggleIndex(),
    },
    // §01: "every control shows its key". The traversal keys are §02b's, but
    // reaching the list with them is new, and a binding with nothing on screen
    // naming it is a binding only its author knows about.
    {
      id: 'focus-index',
      label: 'FOCUS · INDEX',
      keys: 'J',
      enabled: () => chrome.index && vault.tree.some((entry) => isListed(entry.path)),
      takesFocus: true,
      // `enterIndex` reports whether focus moved; the palette has already
      // decided it can, via `enabled`, so the answer is discarded here.
      run: () => {
        enterIndex('first')
      },
    },
    // §01: "every action reachable without a mouse", and the link was the one
    // that was not — the marks answered a click and nothing else. §02b draws no
    // keyboard follow, so the key is new and this row is what puts it on screen,
    // exactly as FOCUS · INDEX above does for its own.
    //
    // Offered whenever a note is open rather than only when the caret is in a
    // link: the palette cannot see the caret, and the editor says so itself when
    // there is nothing under it.
    {
      id: 'follow',
      label: 'FOLLOW · LINK AT CARET',
      keys: '⌘↵',
      enabled: () => vault.openPath !== null,
      takesFocus: true,
      run: () => chrome.followLink(),
    },
    {
      id: 'copy',
      label: 'COPY AS MARKDOWN',
      keys: '',
      enabled: () => vault.openPath !== null,
      run: async () => {
        // The buffer, not the file: what the user is looking at is what they
        // mean to copy, and it may not have been saved yet.
        await navigator.clipboard.writeText(vault.buffer)
        vault.notice = 'Copied as markdown.'
      },
    },
    {
      id: 'reload',
      label: 'RELOAD FROM DISK',
      keys: '',
      enabled: () => vault.openPath !== null,
      run: () => vault.reloadFromDisk(),
    },
    // §02b Screen 4. Hidden with nothing to resolve, like every other command
    // that cannot act — and the newest first, because that is the one that just
    // happened.
    {
      id: 'resolve',
      label: 'RESOLVE · CONFLICT',
      keys: '',
      enabled: () => vault.unresolved.length > 0,
      run: () => go.newestConflict(),
    },
    // §04 Rev P. Both arm the palette rather than acting, so the confirm is the
    // same surface however a deletion is started — the other way in is `⌫` on a
    // focused INDEX row, which names its own target instead of inferring one.
    {
      id: 'delete-note',
      label: 'DELETE · NOTE → TRASH',
      keys: '⌫',
      enabled: () => vault.openPath !== null,
      takesFocus: true,
      run: () => {
        const path = vault.openPath
        if (path !== null) chrome.arm({ kind: 'note', path, notes: 1, rev: vault.rev })
      },
    },
    // The folder the open note is in — the only folder the palette can name
    // without a row to point at. Hidden for a note at the vault root, where
    // there is no folder to mean.
    {
      id: 'delete-folder',
      label: 'DELETE · FOLDER → TRASH',
      keys: '',
      enabled: () => openFolder() !== null,
      takesFocus: true,
      run: () => {
        const folder = openFolder()
        if (folder !== null) {
          chrome.arm({
            kind: 'folder',
            path: folder,
            notes: notesUnder(vault.tree, folder),
            rev: vault.rev,
          })
        }
      },
    },
    // §04 Rev Y. Typed as `MOVE <destination>` in the box, because a move needs
    // a second path and the palette is the only surface that takes one — the
    // same shape as typing a folder for a new note, which the reader has met.
    {
      id: 'move',
      label: 'MOVE · NOTE',
      keys: '',
      takesQuery: true,
      enabled: () => vault.openPath !== null,
      takesFocus: true,
      run: (query: string) => {
        const path = vault.openPath
        if (path === null) return
        const to = destination(query, path)
        if (to === null) {
          vault.notice = 'Type where it should go: MOVE archive/003-note.md'
          return
        }
        chrome.arm({
          kind: 'move',
          path,
          to,
          notes: 1,
          rev: vault.rev,
          repoint: rewrites(vault.corpus, path, to).length,
        })
      },
    },
    {
      id: 'reveal',
      label: 'OPEN VAULT IN FILE MANAGER',
      keys: '',
      run: async () => {
        try {
          await revealVault()
        } catch (error) {
          vault.notice = error instanceof Error ? error.message : String(error)
        }
      },
    },
  ]
}

/**
 * The destination a `MOVE …` query names, or null when it names none.
 *
 * A bare folder means "keep the filename": `MOVE archive` moves
 * `notes/003-a.md` to `archive/003-a.md`, which is what a person means nine
 * times in ten. Anything ending `.md` is taken whole, so a rename is the same
 * command and needs no second one.
 */
export function destination(query: string, from: string): string | null {
  const typed = query.replace(/^move\s+/i, '').trim()
  // Unchanged means the query never said `MOVE`, so it names no destination —
  // running the command from a bare `MOVE` should say what to type rather than
  // guess a folder.
  if (typed === '' || typed === query.trim()) return null
  if (typed.endsWith('.md')) return typed
  return `${typed.replace(/\/$/, '')}/${from.split('/').pop() ?? from}`
}

/**
 * The folder holding the open note, or null when it sits at the vault root.
 *
 * The deepest one, not the whole trail: `notes/projects/010.md` offers
 * `notes/projects`. Deleting the outer folder is a bigger operation than the
 * command's label implies, and it is one keystroke away from the row itself.
 */
export function openFolder(): string | null {
  const path = vault.openPath
  if (path === null) return null
  const trail = folders(path)
  return trail.length === 0 ? null : trail.join('/')
}

/**
 * How short a query has to be before folder suggestions are noise.
 *
 * One character matches almost every folder a vault has, on a surface whose
 * other rows are what the reader is usually after. Two is what "pr" needs.
 */
const FOLDER_MIN = 2

/** How many to offer. A completion list that scrolls is not a completion list. */
const FOLDER_LIMIT = 5

/** An existing folder the typed query could mean. */
export interface FolderChoice {
  /** The real vault path, which is also what choosing it types for you. */
  path: string
  /** Listed notes already in it, so the row says how big a place this is. */
  notes: number
}

/**
 * Existing folders the query could be naming, best match first.
 *
 * Subsequence matching against the **whole** path, which is the same rule the
 * commands take — `tgi` finds TOGGLE INSPECTOR, and `pr` finds `notes/projects`.
 * Matching the full path rather than the last segment is what makes this need no
 * mode. Choosing a row types `notes/projects/`, and from there the only paths
 * still matching are the ones *inside* it — so the list narrows to the nested
 * folders, which is the next completion rather than noise. The moment a title
 * follows the separator nothing matches and the section clears itself. There is
 * no flag, and nothing to turn off.
 */
export function folderChoices(query: string): FolderChoice[] {
  const typed = query.trim()
  if (typed.length < FOLDER_MIN) return []

  return folderTargets(vault.tree)
    .map((path) => ({ path, score: fuzzyScore(path, typed) }))
    .filter((row): row is { path: string; score: number } => row.score !== null)
    .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
    .slice(0, FOLDER_LIMIT)
    .map((row) => ({ path: row.path, notes: notesUnder(vault.tree, row.path) }))
}

/** A stencil in `templates/`, offered as an action rather than as a note. */
export interface TemplateChoice {
  path: string
  /** What to call it in the list: its title, or its filename. */
  name: string
  /** The title the new note will take if it is chosen now. */
  title: string
  /** Where it goes, or null for §04's default. Read from the typed path. */
  folder: string | null
}

/** What a note gets called when it is cut from a stencil with nothing typed. */
export const UNTITLED = 'Untitled note'

/**
 * The templates a new note can be cut from (§08 P7: "notes in templates/ appear
 * under NEW FROM TEMPLATE").
 *
 * Deliberately not filtered by the query, unlike notes and commands: the query
 * IS the new note's title, so filtering would hide every template the moment you
 * typed a name for the thing you wanted to create.
 *
 * With the box empty this used to fall back to the stencil's own title, and a
 * stencil's title is a placeholder — `templates/daily.md` is titled `TEMPLATE`,
 * so pressing Enter on an empty box produced a note called TEMPLATE, sitting in
 * the index next to real notes. A stencil's title names the stencil, not the
 * thing you are about to write, so it is never the new note's title now: the
 * fallback is what `N` already calls a note nobody has named.
 */
export function templateChoices(query: string): TemplateChoice[] {
  // The query may name where the note goes as well as what it is called, so the
  // title is what is left after the last separator rather than the whole line.
  const { folder, title } = splitFolder(query)

  return vault.tree
    .filter((entry) => isTemplate(entry.path))
    .map((entry) => ({
      path: entry.path,
      name: entry.title ?? basename(entry.path),
      title: title === '' ? UNTITLED : title,
      folder,
    }))
}

function basename(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '')
}

export interface Match {
  command: Command
  score: number
}

/**
 * Subsequence matching, the way a command palette is expected to behave: `tgi`
 * finds "TOGGLE INSPECTOR".
 *
 * The score prefers matches whose characters land close together and early, so
 * an exact prefix beats a scattered subsequence.
 */
export function fuzzyScore(haystack: string, needle: string): number | null {
  if (needle === '') return 0
  const text = haystack.toLowerCase()
  const query = needle.toLowerCase()

  let at = 0
  let score = 0
  let previous = -1

  for (const character of query) {
    const found = text.indexOf(character, at)
    if (found === -1) return null
    // Adjacent characters are worth more than scattered ones, and an early
    // match is worth more than a late one.
    score += previous === found - 1 ? 0 : found - at + 1
    previous = found
    at = found + 1
  }
  return score
}

export function matchCommands(query: string): Command[] {
  return allCommands()
    .filter((command) => command.enabled?.() ?? true)
    .map((command) => ({ command, score: score(command, query) }))
    .filter((entry): entry is { command: Command; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score)
    .map((entry) => withDetail(entry.command, query))
}

/**
 * How well a command answers the query, or null when it does not.
 *
 * NEW · NOTE is exempt from the match for the reason `templateChoices` is: the
 * query is its *argument*, not a filter over it. Scoring it like the others hid
 * it the moment a title was typed — `Launch plan` does not fuzzy-match
 * `NEW · NOTE` — so the one row that could act on what you had written was the
 * one row that disappeared while you wrote it, leaving only the stencils.
 * Sorted last of the exact matches rather than first, so it never displaces a
 * note you were looking for.
 */
function score(command: Command, query: string): number | null {
  const matched = fuzzyScore(command.label, query)
  if (command.takesQuery === true) return matched ?? Number.MAX_SAFE_INTEGER
  return matched
}

/**
 * Say what NEW · NOTE is about to make.
 *
 * The row would otherwise read `NEW · NOTE` whether or not a title had been
 * typed, which gives no sign the typing was noticed — and this command is the
 * one place where what is in the box changes what the row does.
 */
function withDetail(command: Command, query: string): Command {
  if (command.id !== 'new') return command
  const { title } = splitFolder(query)
  return title === '' ? command : { ...command, detail: title }
}
