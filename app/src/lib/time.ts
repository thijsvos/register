/** ISO-8601 UTC, seconds precision: `2026-08-05 09:16:40Z`. Timestamps are UTC
 *  everywhere in the chrome (§02) — local time is never displayed. */
export function utcStamp(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19).replace('T', ' ')}Z`
}

/** ISO-8601 UTC to the second, `2026-08-05T09:16:40Z` — §04's `modified`. */
export function isoStamp(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19)}Z`
}
