import { describe, expect, it } from 'vitest'
import { utcStamp } from './time'

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
