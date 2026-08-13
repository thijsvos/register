/** ISO-8601 UTC, seconds precision: `2026-08-05 09:16:40Z`. Timestamps are UTC
 *  everywhere in the chrome (§02) — local time is never displayed. */
export function utcStamp(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19).replace('T', ' ')}Z`
}

/** ISO-8601 UTC to the second, `2026-08-05T09:16:40Z` — §04's `modified`. */
export function isoStamp(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19)}Z`
}

/**
 * A `created:` or `modified:` field, as the chrome shows it: `2026-08-04
 * 13:47:00Z`, which is `utcStamp`'s shape rather than the file's.
 *
 * Presentation only — the same instant, still UTC (§02), with the `T` traded
 * for the space the rest of the chrome uses. A bare date has no time to move
 * and is passed through, and so is anything that is not a stamp at all: §04
 * says these fields are "maintained by whoever writes", so a human who typed
 * something else into one should see what they typed rather than a dash.
 */
const ISO_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/

export function chromeStamp(value: string): string {
  const match = ISO_STAMP.exec(value.trim())
  return match === null ? value : `${match[1]} ${match[2]}Z`
}
