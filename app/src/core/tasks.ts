/**
 * Tasks, parsed out of the corpus and never stored (§04: "- [ ] tasks are plain
 * text. Nothing else is special").
 *
 * The TODAY view is an aggregate over the whole vault, computed on read. There
 * is no task list anywhere in the vault — only notes with lines in them — so a
 * toggle here is an edit to one character of one file, and that file is the only
 * record there has ever been.
 */
import type { Entry, Loaded } from './api'
import { linkable } from './links'
import { isTemplate } from './refs'
import { bodyLines } from './scan'

export interface Task {
  /** Vault path of the note the line lives in. */
  path: string
  /** Character offset of the `[` in that note. The state character is at +1. */
  at: number
  done: boolean
  /** The text after the box, trimmed. Markdown left literal. */
  text: string
}

/** Notes that have tasks, in tree order, with theirs. */
export interface TaskGroup {
  entry: Entry
  tasks: Task[]
}

/**
 * A GFM task list item: any list marker, then a box.
 *
 * Every marker GFM allows, because the editor's decoration comes off
 * `@lezer/markdown`'s GFM extension, which attaches a TaskMarker to a list item
 * whatever bullet it carries. A row you can tick in the editor and cannot see in
 * TODAY would be the same file disagreeing with itself.
 */
const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?:\s(.*))?$/

/** Every task in one note, in document order. */
export function tasksIn(path: string, source: string): Task[] {
  const out: Task[] = []

  for (const line of bodyLines(source)) {
    // A `- [ ]` inside a fence is a code sample, not something you have to do.
    if (line.fenced) continue
    const match = TASK.exec(line.text)
    if (match === null) continue

    out.push({
      path,
      at: line.from + (match[1] ?? '').length,
      done: (match[2] ?? ' ') !== ' ',
      text: (match[3] ?? '').trim(),
    })
  }

  return out
}

/**
 * Flip the box at `at`, or null if it is not where it was.
 *
 * The offset came from a snapshot, and the file may have moved underneath it —
 * an agent inserting a paragraph shifts every task below it. Checking the three
 * characters before splicing is what stops a stale offset from rewriting the
 * middle of a sentence.
 */
export function toggle(source: string, at: number): string | null {
  const box = source.slice(at, at + 3)
  if (!/^\[[ xX]\]$/.test(box)) return null

  const done = box[1] !== ' '
  // One character replaced, the smallest edit that expresses the change, so the
  // vault's diff stays clean and an agent reading the file sees only that.
  return `${source.slice(0, at + 1)}${done ? ' ' : 'x'}${source.slice(at + 2)}`
}

/**
 * Tasks across the vault, grouped by note (§02b Screen 5).
 *
 * Templates are left out. A stencil's `- [ ]` is a placeholder for a task, not a
 * task — otherwise `templates/daily.md` would put the same unfinished line on
 * your plate every day of your life and there would be no way to tick it off.
 * Conflict copies are left out for the reason every other derivation leaves them
 * out: they carry the original's lines and would double every one of them.
 */
export function taskGroups(notes: Entry[], corpus: Record<string, Loaded>): TaskGroup[] {
  const groups: TaskGroup[] = []

  for (const entry of linkable(notes)) {
    if (isTemplate(entry.path)) continue
    const held = corpus[entry.path]
    if (held === undefined) continue

    const tasks = tasksIn(entry.path, held.body)
    if (tasks.length > 0) groups.push({ entry, tasks })
  }

  return groups
}

export interface TaskCount {
  open: number
  total: number
}

export function count(groups: TaskGroup[]): TaskCount {
  let open = 0
  let total = 0
  for (const group of groups) {
    for (const task of group.tasks) {
      total++
      if (!task.done) open++
    }
  }
  return { open, total }
}
