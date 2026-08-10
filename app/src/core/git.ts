/**
 * §02b Screen 1's GIT field, in git's own shorthand.
 *
 * The field used to read CLEAN or DIRTY. Neither is what git prints, and the
 * pair could not say *what* had changed — a vault with one untracked note and a
 * vault mid-rebase both read DIRTY. This says it the way `git status --short`
 * and every shell prompt do: the branch, then one mark per column.
 *
 * `+` index against HEAD · `~` worktree against the index · `?` untracked ·
 * `↑` commits the upstream has not seen.
 *
 * A mark is drawn only when its count is above zero, so a clean vault on `main`
 * is just `MAIN` — §02's "every pixel accounted for" applies to the status bar
 * more than anywhere, since it is 30px of rail shared with five other fields.
 */
import type { GitStatus } from './api'

/** What a detached head is called, since there is no branch name to print. */
export const DETACHED = 'detached'

/**
 * The GIT field's text, or `null` when there is nothing true to say.
 *
 * `null` renders as the em dash, and it means one of two measured absences: the
 * vault is not a repository of its own, or nothing could answer. Never a guess.
 */
export function gitLabel(status: GitStatus | null): string | null {
  if (status === null) return null

  const marks: string[] = []
  // Commits first: the branch's position against its upstream is about history,
  // and the three that follow are about the tree in front of you.
  if (status.ahead !== null && status.ahead > 0) marks.push(`↑${status.ahead}`)
  if (status.staged > 0) marks.push(`+${status.staged}`)
  if (status.modified > 0) marks.push(`~${status.modified}`)
  if (status.untracked > 0) marks.push(`?${status.untracked}`)

  return [status.branch ?? DETACHED, ...marks].join(' ')
}
