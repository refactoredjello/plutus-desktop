/**
 * services/schedule.ts: its documented behaviour and edge cases: month-end clamping without drift, the semimonthly pairing, leap years, and
 * the half-open window of `occurrences`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { type PlainDate, plainDate } from '../src/lib/dates.js'
import {
  MONTH_END_FROM,
  addMonths,
  nextAfter,
  nthOccurrence,
  occurrences,
  today,
} from '../src/services/schedule.js'

const d = (s: string): PlainDate => plainDate(s)
const series = (anchor: string, cadence: Parameters<typeof nthOccurrence>[1], count: number) =>
  Array.from({ length: count }, (_, n) => nthOccurrence(d(anchor), cadence, n))

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('today', () => {
  it('reads PLUTUS_TODAY at call time', () => {
    vi.stubEnv('PLUTUS_TODAY', '2026-10-03')
    expect(today()).toBe('2026-10-03')
    vi.stubEnv('PLUTUS_TODAY', '2027-01-01')
    expect(today()).toBe('2027-01-01')
  })
})

describe('addMonths', () => {
  it('clamps to the end of the target month', () => {
    expect(addMonths(d('2026-01-31'), 1)).toBe('2026-02-28')
    expect(addMonths(d('2028-01-31'), 1)).toBe('2028-02-29')
    expect(addMonths(d('2026-03-31'), -1)).toBe('2026-02-28')
    expect(addMonths(d('2026-01-15'), -18)).toBe('2024-07-15')
  })
})

describe('MONTH_END_FROM', () => {
  it('is the 28th', () => {
    expect(MONTH_END_FROM).toBe(28)
  })
})

describe('nthOccurrence', () => {
  it('n=0 is the anchor for every cadence', () => {
    for (const cadence of ['weekly', 'biweekly', 'semimonthly', 'monthly', 'yearly'] as const) {
      expect(nthOccurrence(d('2026-09-20'), cadence, 0)).toBe('2026-09-20')
    }
  })

  it('steps weekly and biweekly by days across month and year ends', () => {
    expect(series('2026-12-24', 'weekly', 3)).toEqual(['2026-12-24', '2026-12-31', '2027-01-07'])
    expect(series('2026-12-24', 'biweekly', 3)).toEqual(['2026-12-24', '2027-01-07', '2027-01-21'])
    expect(nthOccurrence(d('2028-02-22'), 'weekly', 1)).toBe('2028-02-29')
  })

  it('computes monthly from the anchor so month-end clamping never drifts', () => {
    expect(series('2026-01-31', 'monthly', 4)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
  })

  it('clamps yearly from a leap day and returns to it in the next leap year', () => {
    expect(nthOccurrence(d('2028-02-29'), 'yearly', 1)).toBe('2029-02-28')
    expect(nthOccurrence(d('2028-02-29'), 'yearly', 4)).toBe('2032-02-29')
    expect(nthOccurrence(d('2100-02-28'), 'yearly', 0)).toBe('2100-02-28')
    expect(nthOccurrence(d('2096-02-29'), 'yearly', 4)).toBe('2100-02-28')
  })

  it('refuses a non-repeating cadence', () => {
    expect(() => nthOccurrence(d('2026-09-20'), 'none', 1)).toThrow("Cannot repeat with cadence 'none'")
  })
})

describe('semimonthly', () => {
  it('pairs a month-end anchor (day 28 or later) with the 15th', () => {
    expect(series('2026-01-31', 'semimonthly', 5)).toEqual([
      '2026-01-31',
      '2026-02-15',
      '2026-02-28',
      '2026-03-15',
      '2026-03-31',
    ])
    expect(series('2026-04-30', 'semimonthly', 3)).toEqual(['2026-04-30', '2026-05-15', '2026-05-31'])
  })

  it('moves a 28th-30th anchor to the actual month end, even for n=0', () => {
    expect(series('2026-01-28', 'semimonthly', 3)).toEqual(['2026-01-31', '2026-02-15', '2026-02-28'])
    expect(nthOccurrence(d('2026-03-30'), 'semimonthly', 0)).toBe('2026-03-31')
    expect(nthOccurrence(d('2026-02-28'), 'semimonthly', 0)).toBe('2026-02-28')
  })

  it('pairs a day of 13 to 15 with month end, leap years included', () => {
    expect(series('2026-02-14', 'semimonthly', 4)).toEqual([
      '2026-02-14',
      '2026-02-28',
      '2026-03-14',
      '2026-03-31',
    ])
    expect(series('2028-02-13', 'semimonthly', 3)).toEqual(['2028-02-13', '2028-02-29', '2028-03-13'])
    expect(series('2026-09-15', 'semimonthly', 3)).toEqual(['2026-09-15', '2026-09-30', '2026-10-15'])
  })

  it('pairs any other day up to 12 with d + 15', () => {
    expect(series('2026-09-01', 'semimonthly', 4)).toEqual([
      '2026-09-01',
      '2026-09-16',
      '2026-10-01',
      '2026-10-16',
    ])
    expect(series('2026-02-12', 'semimonthly', 3)).toEqual(['2026-02-12', '2026-02-27', '2026-03-12'])
  })

  it('pairs a day of 16 to 27 with d - 15, the anchor being the high half', () => {
    expect(series('2026-09-20', 'semimonthly', 4)).toEqual([
      '2026-09-20',
      '2026-10-05',
      '2026-10-20',
      '2026-11-05',
    ])
    expect(series('2026-12-27', 'semimonthly', 3)).toEqual(['2026-12-27', '2027-01-12', '2027-01-27'])
  })

  it('crosses the year end', () => {
    expect(nextAfter(d('2026-12-31'), 'semimonthly')).toBe('2027-01-15')
    expect(nextAfter(d('2026-12-16'), 'semimonthly')).toBe('2027-01-01')
  })

  it('steps backwards for a negative n, like divmod', () => {
    expect(nthOccurrence(d('2026-09-16'), 'semimonthly', -1)).toBe('2026-09-01')
    expect(nthOccurrence(d('2026-09-01'), 'semimonthly', -1)).toBe('2026-08-16')
    expect(nthOccurrence(d('2026-03-31'), 'semimonthly', -1)).toBe('2026-03-15')
    expect(nthOccurrence(d('2026-03-31'), 'semimonthly', -2)).toBe('2026-02-28')
  })
})

describe('nextAfter', () => {
  it('is one cadence step', () => {
    expect(nextAfter(d('2026-09-14'), 'monthly')).toBe('2026-10-14')
    expect(nextAfter(d('2026-09-16'), 'yearly')).toBe('2027-09-16')
    expect(nextAfter(d('2026-09-25'), 'biweekly')).toBe('2026-10-09')
    expect(nextAfter(d('2026-09-30'), 'semimonthly')).toBe('2026-10-15')
  })
})

describe('occurrences', () => {
  it('yields dates with after < d <= upto', () => {
    expect([...occurrences(d('2026-01-31'), 'monthly', d('2026-01-31'), d('2026-04-30'))]).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
    expect([...occurrences(d('2026-01-31'), 'monthly', d('2026-01-30'), d('2026-04-29'))]).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ])
  })

  it('stays anchored across a long window (no month-end drift)', () => {
    const got = [...occurrences(d('2026-01-31'), 'monthly', d('2026-06-01'), d('2026-09-30'))]
    expect(got).toEqual(['2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30'])
  })

  it('yields nothing when the anchor is after upto', () => {
    expect([...occurrences(d('2026-10-01'), 'weekly', d('2026-01-01'), d('2026-09-30'))]).toEqual([])
  })

  it('yields a non-repeating anchor once, only inside the window', () => {
    const anchor = d('2026-09-15')
    expect([...occurrences(anchor, 'none', d('2026-09-14'), d('2026-09-15'))]).toEqual(['2026-09-15'])
    expect([...occurrences(anchor, 'none', d('2026-09-15'), d('2026-09-30'))]).toEqual([])
    expect([...occurrences(anchor, 'none', d('2026-09-01'), d('2026-09-14'))]).toEqual([])
  })

  it('yields semimonthly pairs in order', () => {
    const got = [...occurrences(d('2026-01-15'), 'semimonthly', d('2026-01-31'), d('2026-03-15'))]
    expect(got).toEqual(['2026-02-15', '2026-02-28', '2026-03-15'])
  })
})
