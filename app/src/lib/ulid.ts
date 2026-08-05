/** Crockford base32 — no I, L, O or U, so a ULID cannot be misread aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_CHARS = 10
const RANDOM_CHARS = 16

/**
 * A ULID: 48 bits of millisecond timestamp then 80 bits of randomness, 26
 * Crockford-base32 characters, lexicographically sortable.
 *
 * §04 requires one per note and requires that it never change once written, so
 * this is only ever called when creating a note.
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}

function encodeTime(ms: number): string {
  let remaining = Math.floor(ms)
  let out = ''
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ALPHABET.charAt(remaining % 32) + out
    remaining = Math.floor(remaining / 32)
  }
  return out
}

function encodeRandom(): string {
  // 256 is a whole multiple of 32, so the modulo is unbiased.
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_CHARS))
  let out = ''
  for (const byte of bytes) out += ALPHABET.charAt(byte % 32)
  return out
}
