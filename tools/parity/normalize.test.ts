import { describe, expect, it } from 'vitest'
import {
  type Json,
  type TieRule,
  VOLATILE_KEYS,
  VOLATILE_MARK,
  canonicalInstant,
  normalize,
} from './normalize.ts'

describe('canonicalInstant', () => {
  it('reads microseconds (Python) and milliseconds (JavaScript) as the same second', () => {
    expect(canonicalInstant('2026-09-30T12:00:00.611088Z')).toBe('2026-09-30T12:00:01Z')
    expect(canonicalInstant('2026-09-30T12:00:00.611Z')).toBe('2026-09-30T12:00:01Z')
    expect(canonicalInstant('2026-09-30T12:00:00.211088Z')).toBe('2026-09-30T12:00:00Z')
    expect(canonicalInstant('2026-09-30T12:00:00.211Z')).toBe('2026-09-30T12:00:00Z')
  })

  it('reads a timestamp without a fraction', () => {
    expect(canonicalInstant('2026-09-30T12:00:00Z')).toBe('2026-09-30T12:00:00Z')
  })

  it('treats the same instant in different offsets as equal', () => {
    const utc = canonicalInstant('2026-09-30T12:00:00Z')
    expect(canonicalInstant('2026-09-30T12:00:00+00:00')).toBe(utc)
    expect(canonicalInstant('2026-09-30T14:00:00+02:00')).toBe(utc)
    expect(canonicalInstant('2026-09-30T07:30:00-04:30')).toBe(utc)
    expect(canonicalInstant('2026-10-01T01:00:00+1300')).toBe(utc)
  })

  it('rounds half a second up, consistently for truncated milliseconds', () => {
    expect(canonicalInstant('2026-09-30T12:00:00.5Z')).toBe('2026-09-30T12:00:01Z')
    expect(canonicalInstant('2026-09-30T12:00:00.499999Z')).toBe('2026-09-30T12:00:00Z')
    // .9996 s in microseconds and its millisecond truncation .999 both round to the next second
    expect(canonicalInstant('2026-12-31T23:59:59.999600Z')).toBe('2027-01-01T00:00:00Z')
    expect(canonicalInstant('2026-12-31T23:59:59.999Z')).toBe('2027-01-01T00:00:00Z')
  })

  it('does not read plain dates, naive timestamps, or impossible dates as instants', () => {
    expect(canonicalInstant('2026-09-30')).toBeNull()
    expect(canonicalInstant('2026-09-30T12:00:00')).toBeNull()
    expect(canonicalInstant('2026-09-30 12:00:00Z')).toBeNull()
    expect(canonicalInstant('2026-02-30T12:00:00Z')).toBeNull()
    expect(canonicalInstant('2026-09-30T24:00:00Z')).toBeNull()
    expect(canonicalInstant('15.49')).toBeNull()
    expect(canonicalInstant('Coffee')).toBeNull()
  })
})

describe('normalize', () => {
  it('rewrites deterministic timestamps anywhere in the tree to the canonical second', () => {
    const python: Json = {
      accounts: [{ id: 1, balance_as_of: '2026-09-30T12:00:00.000001Z', balance: '4210.55' }],
    }
    expect(normalize(python)).toEqual({
      accounts: [{ id: 1, balance_as_of: '2026-09-30T12:00:00Z', balance: '4210.55' }],
    })
  })

  it('keeps money strings exactly as sent', () => {
    expect(normalize({ amount: '15.49' })).toEqual({ amount: '15.49' })
    expect(normalize({ amount: '15.490' })).toEqual({ amount: '15.490' })
    expect(normalize({ amount: '-0.00' })).toEqual({ amount: '-0.00' })
  })

  it('keeps plain dates as strings', () => {
    expect(normalize({ posted_on: '2026-09-30' })).toEqual({ posted_on: '2026-09-30' })
  })

  it('masks wall-clock fields only when they hold a valid instant', () => {
    expect(VOLATILE_KEYS.has('created_at')).toBe(true)
    expect(VOLATILE_KEYS.has('started_at')).toBe(true)
    expect(VOLATILE_KEYS.has('balance_as_of')).toBe(false)
    expect(normalize({ created_at: '2026-10-17T22:28:21.611088Z' })).toEqual({
      created_at: VOLATILE_MARK,
    })
    expect(normalize({ finished_at: null })).toEqual({ finished_at: null })
    // A naive or malformed value is a finding, so it stays visible.
    expect(normalize({ created_at: '2026-10-17T22:28:21' })).toEqual({
      created_at: '2026-10-17T22:28:21',
    })
    expect(normalize({ created_at: 1790769600 })).toEqual({ created_at: 1790769600 })
  })

  it('accepts a custom set of volatile keys', () => {
    expect(normalize({ created_at: '2026-10-17T22:28:21Z' }, { volatileKeys: new Set() })).toEqual({
      created_at: '2026-10-17T22:28:21Z',
    })
  })

  it('leaves list order alone without a rule', () => {
    expect(normalize([3, 1, 2])).toEqual([3, 1, 2])
    expect(normalize({ items: [{ id: 2 }, { id: 1 }] })).toEqual({ items: [{ id: 2 }, { id: 1 }] })
  })

  const byTotal: TieRule = {
    path: '',
    orderBy: 'total',
    tieBreak: 'category_id',
    reason: 'sorted by total; ties keep Postgres GROUP BY order',
  }

  it('orders ties of a documented partially ordered list by the tie key', () => {
    const python: Json = [
      { category_id: 9, total: '50.00' },
      { category_id: 7, total: '20.00' },
      { category_id: 3, total: '20.00' },
      { category_id: null, total: '20.00' },
      { category_id: 1, total: '5.00' },
    ]
    expect(normalize(python, { ties: [byTotal] })).toEqual([
      { category_id: 9, total: '50.00' },
      { category_id: null, total: '20.00' },
      { category_id: 3, total: '20.00' },
      { category_id: 7, total: '20.00' },
      { category_id: 1, total: '5.00' },
    ])
  })

  it('never reorders items whose order key differs', () => {
    const wrong: Json = [
      { category_id: 1, total: '5.00' },
      { category_id: 9, total: '50.00' },
    ]
    expect(normalize(wrong, { ties: [byTotal] })).toEqual(wrong)
  })

  it('applies a tie rule at a nested path, and with a wildcard index', () => {
    const rule: TieRule = { ...byTotal, path: '/categories' }
    const body: Json = {
      month: '2026-09',
      categories: [
        { category_id: 7, total: '20.00' },
        { category_id: 3, total: '20.00' },
      ],
      other: [
        { category_id: 7, total: '20.00' },
        { category_id: 3, total: '20.00' },
      ],
    }
    expect(normalize(body, { ties: [rule] })).toEqual({
      month: '2026-09',
      categories: [
        { category_id: 3, total: '20.00' },
        { category_id: 7, total: '20.00' },
      ],
      other: [
        { category_id: 7, total: '20.00' },
        { category_id: 3, total: '20.00' },
      ],
    })
    const wild: TieRule = { ...byTotal, path: '/*/rows' }
    expect(
      normalize(
        [
          {
            rows: [
              { category_id: 2, total: '1.00' },
              { category_id: 1, total: '1.00' },
            ],
          },
        ],
        { ties: [wild] },
      ),
    ).toEqual([
      {
        rows: [
          { category_id: 1, total: '1.00' },
          { category_id: 2, total: '1.00' },
        ],
      },
    ])
  })

  it('does not mutate its input', () => {
    const input: Json = [
      { category_id: 2, total: '1.00', created_at: '2026-10-17T22:28:21Z' },
      { category_id: 1, total: '1.00', created_at: '2026-10-17T22:28:21Z' },
    ]
    const copy = structuredClone(input)
    normalize(input, { ties: [byTotal] })
    expect(input).toEqual(copy)
  })
})
