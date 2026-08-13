import { describe, expect, it } from 'vitest'
import { chromeStamp, isoStamp, utcStamp } from './time'

describe('utcStamp', () => {
  it('renders ISO-8601 UTC to the second', () => {
    expect(utcStamp(new Date('2026-08-05T09:16:40.000Z'))).toBe('2026-08-05 09:16:40Z')
  })

  it('truncates sub-second time rather than rounding it', () => {
    expect(utcStamp(new Date('2026-08-05T09:16:40.999Z'))).toBe('2026-08-05 09:16:40Z')
  })

  it('zero-pads single-digit months, days and times', () => {
    expect(utcStamp(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02 03:04:05Z')
  })

  it('reports UTC, never local time', () => {
    // 23:30 in a +02:00 zone is the previous day in UTC — a local-time
    // formatter would print 2026-08-06.
    expect(utcStamp(new Date('2026-08-06T01:30:00+02:00'))).toBe('2026-08-05 23:30:00Z')
  })

  it('round-trips back to a valid Date for the <time datetime> attribute', () => {
    const stamp = utcStamp(new Date('2026-08-05T09:16:40.000Z'))
    expect(new Date(stamp.replace(' ', 'T')).toISOString()).toBe(
      '2026-08-05T09:16:40.000Z',
    )
  })
})

/**
 * §02b Screen 1's meta strip reads `created` and `modified` straight out of the
 * note, and §04 says those are "maintained by whoever writes" — so the input is
 * whatever is in the file, not something this app produced.
 */
describe('chromeStamp', () => {
  it('gives a §04 stamp the shape the rest of the chrome uses', () => {
    expect(chromeStamp('2026-08-04T13:47:00Z')).toBe('2026-08-04 13:47:00Z')
  })

  it('agrees with utcStamp, which is the shape it is copying', () => {
    // The two ends of one round trip: `isoStamp` is what this app writes into a
    // note's `modified`, and this is how the chrome reads it back.
    const now = new Date('2026-08-05T09:16:40.000Z')
    expect(chromeStamp(isoStamp(now))).toBe(utcStamp(now))
  })

  it('drops sub-second precision a hand-written stamp may carry', () => {
    expect(chromeStamp('2026-08-04T13:47:00.512Z')).toBe('2026-08-04 13:47:00Z')
  })

  it('leaves a bare date alone — it has no time to move', () => {
    expect(chromeStamp('2026-07-28')).toBe('2026-07-28')
  })

  it.each([
    ['prose somebody typed', 'last tuesday'],
    ['a local time, which §04 does not define', '2026-08-04T13:47:00+02:00'],
    ['an empty field', ''],
  ])('shows %s exactly as written rather than blanking it', (_label, value) => {
    // Reformatting only what it recognises is the whole rule: a field this
    // cannot read is still the writer's, and a dash in its place would report
    // the note as having no date when it plainly says one.
    expect(chromeStamp(value)).toBe(value)
  })

  it('trims, so a stray space does not defeat the match', () => {
    expect(chromeStamp('  2026-08-04T13:47:00Z ')).toBe('2026-08-04 13:47:00Z')
  })
})
