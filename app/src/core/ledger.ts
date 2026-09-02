/**
 * What the ledger says (§08 P12, §02b Screen 11).
 *
 * The server answers with rows — one commit's word on one note — and this is
 * the little that is derived from them on the client. Nothing is stored: the
 * ledger is the vault's own git log, and these are ways of reading it.
 */
import type { Version } from './api'

/**
 * What landed outside the app since you last wrote to it.
 *
 * "Outside" means not through this app: a checkpoint that attributed a path
 * to something else, one it attributed to both, or a commit made by hand —
 * which the server reports as itself and attributes to nobody, because it
 * cannot see who typed `git commit`. Counted down from the newest row until
 * one says `you`: those rows landed after your last save, and nothing on
 * screen has said a word about them.
 *
 * Rows are one per note per commit, so the count is in notes — which is what
 * `3 outside` should mean to a reader.
 */
export function outsideSince(rows: Version[]): Version[] {
  const out: Version[] = []
  for (const row of rows) {
    if (row.who === 'you') break
    out.push(row)
  }
  return out
}

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
]

/**
 * `17 AUG 14:07Z` — a checkpoint's own stamp, with the day in front.
 *
 * UTC, because every timestamp in the chrome is (§02) and because the subject
 * the checkpoint wrote says `14:07Z`; a row that said `16:07` beside it would
 * be two clocks on one line.
 */
export function when(at: number): string {
  const date = new Date(at * 1000)
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  return `${day} ${MONTHS[date.getUTCMonth()]} ${hours}:${minutes}Z`
}

/**
 * Who, as the row prints it: the checkpoint's word, or the hand that
 * committed. Never a guess — a hand commit is named by its author, which is
 * whatever git was told, and that is what the reader gets.
 */
export function whoLabel(row: Version): string {
  switch (row.who) {
    case 'you':
      return 'you'
    case 'outside':
      return 'outside'
    case 'both':
      return 'you + outside'
    default:
      return row.author === '' ? 'by hand' : `by hand · ${row.author}`
  }
}
