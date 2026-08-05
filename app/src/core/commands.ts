import { chrome } from '../ui/view.svelte'
import { revealVault } from './api'
import { vault } from './store.svelte'

/**
 * One palette entry. §01: "every control shows its key" — so `keys` is not
 * optional decoration, it is part of what a command is.
 */
export interface Command {
  id: string
  label: string
  /** Rendered right-aligned in the palette. Empty when there is no binding. */
  keys: string
  run: () => void | Promise<void>
  /** Hidden when it cannot do anything, rather than shown and inert. */
  enabled?: () => boolean
}

export function allCommands(): Command[] {
  return [
    {
      id: 'new',
      label: 'NEW · NOTE',
      keys: 'N',
      run: () => vault.create('Untitled note'),
    },
    {
      id: 'daily',
      label: 'GO · DAILY LOG',
      keys: 'G D',
      run: () => vault.openDaily(),
    },
    {
      id: 'inbox',
      label: 'GO · INBOX',
      keys: 'G I',
      run: () => vault.follow('000'),
    },
    {
      id: 'invert',
      label: 'INVERT DISPLAY',
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
    .map((command) => ({ command, score: fuzzyScore(command.label, query) }))
    .filter((entry): entry is { command: Command; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.command)
}
