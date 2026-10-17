import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type PlainDate,
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  daysInMonth,
  epochToTimestamp,
  epochToUtcDate,
  monthBounds,
  monthKey,
  plainDate,
  isPlainDate,
  today,
  utcNow,
} from '../src/lib/dates.js'

const d = (s: string): PlainDate => plainDate(s)

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('plainDate', () => {
  it('accepts a real calendar date', () => {
    expect(plainDate('2026-02-28')).toBe('2026-02-28')
    expect(plainDate('2024-02-29')).toBe('2024-02-29')
  })

  it.each(['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-5', '20260105', '', 'x'])(
    'rejects %j',
    (text) => {
      expect(() => plainDate(text)).toThrow()
      expect(isPlainDate(text)).toBe(false)
    },
  )
})

describe('today', () => {
  it('returns the UTC date when PLUTUS_TODAY is unset', () => {
    vi.stubEnv('PLUTUS_TODAY', '')
    vi.useFakeTimers()
    // 23:30 on the 14th in New York is already the 15th in UTC.
    vi.setSystemTime(new Date('2026-03-15T03:30:00Z'))
    expect(today()).toBe('2026-03-15')
  })

  it('returns PLUTUS_TODAY when set', () => {
    vi.stubEnv('PLUTUS_TODAY', '2026-01-31')
    expect(today()).toBe('2026-01-31')
  })

  it('refuses a malformed PLUTUS_TODAY', () => {
    vi.stubEnv('PLUTUS_TODAY', '2026-02-30')
    expect(() => today()).toThrow()
  })
})

describe('utcNow', () => {
  it('is an ISO 8601 UTC timestamp', () => {
    expect(utcNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('addDays', () => {
  it.each([
    ['2026-01-31', 1, '2026-02-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2024-02-28', 1, '2024-02-29'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-01-10', 14, '2026-01-24'],
    ['2026-01-10', 0, '2026-01-10'],
    // DST changes are irrelevant to plain dates.
    ['2026-03-07', 7, '2026-03-14'],
    ['2026-11-01', 1, '2026-11-02'],
  ])('%s + %d days = %s', (start, n, expected) => {
    expect(addDays(d(start), n)).toBe(expected)
  })
})

describe('addMonths (schedule.add_months)', () => {
  it.each([
    ['2026-01-15', 1, '2026-02-15'],
    ['2026-01-31', 1, '2026-02-28'],
    ['2024-01-31', 1, '2024-02-29'],
    ['2026-03-31', 1, '2026-04-30'],
    ['2026-01-31', 2, '2026-03-31'],
    ['2026-12-15', 1, '2027-01-15'],
    ['2026-01-15', -1, '2025-12-15'],
    ['2026-03-31', -1, '2026-02-28'],
    ['2026-05-31', -12, '2025-05-31'],
    ['2024-02-29', 12, '2025-02-28'],
    ['2026-08-31', 0, '2026-08-31'],
    ['2026-01-01', -25, '2023-12-01'],
  ])('%s + %d months = %s', (start, n, expected) => {
    expect(addMonths(d(start), n)).toBe(expected)
  })
})

describe('daysInMonth', () => {
  it.each([
    [2026, 1, 31],
    [2026, 2, 28],
    [2024, 2, 29],
    [1900, 2, 28],
    [2000, 2, 29],
    [2026, 4, 30],
    [2026, 12, 31],
  ])('%d-%d has %d days', (year, month, expected) => {
    expect(daysInMonth(year, month)).toBe(expected)
  })
})

describe('monthKey and monthBounds (aggregates.month_key, month_bounds)', () => {
  it('formats the month of a date', () => {
    expect(monthKey(d('2026-03-09'))).toBe('2026-03')
  })

  it.each([
    ['2026-03', '2026-03-01', '2026-04-01'],
    ['2026-12', '2026-12-01', '2027-01-01'],
    ['2024-02', '2024-02-01', '2024-03-01'],
    ['2026-01', '2026-01-01', '2026-02-01'],
  ])('%s spans [%s, %s)', (month, start, next) => {
    expect(monthBounds(month)).toEqual([start, next])
  })
})

describe('daysBetween and compareDates', () => {
  it('counts whole days from a to b', () => {
    expect(daysBetween(d('2026-01-01'), d('2026-03-01'))).toBe(59)
    expect(daysBetween(d('2026-03-01'), d('2026-01-01'))).toBe(-59)
    expect(daysBetween(d('2024-02-28'), d('2024-03-01'))).toBe(2)
  })

  it('orders dates as strings do', () => {
    expect(compareDates(d('2026-01-02'), d('2026-01-10'))).toBeLessThan(0)
    expect(compareDates(d('2026-01-10'), d('2026-01-10'))).toBe(0)
    expect(compareDates(d('2027-01-01'), d('2026-12-31'))).toBeGreaterThan(0)
  })
})

describe('epoch conversions (datetime.fromtimestamp(seconds, UTC))', () => {
  it('gives the UTC date of a Unix timestamp', () => {
    expect(epochToUtcDate(1772884800)).toBe('2026-03-07')
    // 23:59:59 UTC stays on its day whatever the local zone.
    expect(epochToUtcDate(1772927999)).toBe('2026-03-07')
    expect(epochToUtcDate(1772928000)).toBe('2026-03-08')
  })

  it('gives the ISO UTC timestamp of a Unix timestamp', () => {
    expect(epochToTimestamp(1790769600)).toBe('2026-09-30T12:00:00.000Z')
  })

  it('refuses a non-finite value', () => {
    expect(() => epochToUtcDate(Number.NaN)).toThrow()
  })
})
