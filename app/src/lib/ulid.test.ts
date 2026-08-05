import { describe, expect, it } from 'vitest'
import { ulid } from './ulid'

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/

describe('ulid', () => {
  it('is 26 Crockford-base32 characters', () => {
    expect(ulid()).toMatch(CROCKFORD)
  })

  it('never emits the ambiguous letters', () => {
    const sample = Array.from({ length: 200 }, () => ulid()).join('')
    expect(sample).not.toMatch(/[ILOU]/)
  })

  it('sorts lexicographically by time', () => {
    const early = ulid(new Date('2026-01-01T00:00:00Z').getTime())
    const later = ulid(new Date('2026-08-05T09:16:40Z').getTime())
    expect(early < later).toBe(true)
  })

  it('shares a prefix within the same millisecond and still differs', () => {
    const at = Date.now()
    const a = ulid(at)
    const b = ulid(at)

    expect(a.slice(0, 10)).toBe(b.slice(0, 10))
    expect(a).not.toBe(b)
  })

  it('is unique across a large batch', () => {
    const batch = Array.from({ length: 5000 }, () => ulid())
    expect(new Set(batch).size).toBe(batch.length)
  })
})
