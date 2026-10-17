import { describe, expect, it } from 'vitest'
import { type Envelope, compareResponses, diff } from './diff.ts'
import type { TieRule } from './normalize.ts'

describe('diff', () => {
  it('finds nothing in equal values', () => {
    expect(diff({ a: [1, 'x', null, true] }, { a: [1, 'x', null, true] })).toEqual([])
    expect(diff(null, null)).toEqual([])
  })

  it('ignores object key order', () => {
    expect(diff({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toEqual([])
  })

  it('reports a changed leaf with its path', () => {
    expect(diff({ items: [{ amount: '15.49' }] }, { items: [{ amount: '15.50' }] })).toEqual([
      { path: '/items/0/amount', expected: '15.49', actual: '15.50' },
    ])
  })

  it('compares money as strings, never as numbers', () => {
    expect(diff({ amount: '15.49' }, { amount: 15.49 })).toEqual([
      { path: '/amount', expected: '15.49', actual: 15.49, note: 'type string vs number' },
    ])
    expect(diff({ amount: '15.5' }, { amount: '15.50' })).toEqual([
      { path: '/amount', expected: '15.5', actual: '15.50' },
    ])
  })

  it('reports missing and extra keys', () => {
    expect(diff({ a: 1, b: 2 }, { a: 1, c: 3 })).toEqual([
      { path: '/b', expected: 2, actual: undefined, note: 'missing' },
      { path: '/c', expected: undefined, actual: 3, note: 'unexpected' },
    ])
  })

  it('treats a key holding null differently from a missing key', () => {
    expect(diff({ note: null }, {})).toEqual([
      { path: '/note', expected: null, actual: undefined, note: 'missing' },
    ])
  })

  it('reports type mismatches without descending', () => {
    expect(diff({ a: { b: 1 } }, { a: [1] })).toEqual([
      { path: '/a', expected: { b: 1 }, actual: [1], note: 'type object vs array' },
    ])
    expect(diff({ a: null }, { a: 0 })).toEqual([
      { path: '/a', expected: null, actual: 0, note: 'type null vs number' },
    ])
  })

  it('reports array length, then the common prefix, then the tail', () => {
    expect(diff([1, 2, 3], [1, 5])).toEqual([
      { path: '', expected: 3, actual: 2, note: 'array length' },
      { path: '/1', expected: 2, actual: 5 },
      { path: '/2', expected: 3, actual: undefined, note: 'missing' },
    ])
    expect(diff([], [{ id: 1 }])).toEqual([
      { path: '', expected: 0, actual: 1, note: 'array length' },
      { path: '/0', expected: undefined, actual: { id: 1 }, note: 'unexpected' },
    ])
  })

  it('reports order differences in an ordered list', () => {
    expect(diff([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }])).toEqual([
      { path: '/0/id', expected: 1, actual: 2 },
      { path: '/1/id', expected: 2, actual: 1 },
    ])
  })

  it('compares numbers exactly, including floats parsed from JSON', () => {
    expect(diff(JSON.parse('{"r":0.1234}'), JSON.parse('{"r":0.12340}'))).toEqual([])
    expect(diff({ r: 0.1234 }, { r: 0.1235 })).toEqual([{ path: '/r', expected: 0.1234, actual: 0.1235 }])
  })

  it('escapes slashes and tildes in keys like a JSON pointer', () => {
    expect(diff({ 'a/b': 1, 'c~d': 1 }, { 'a/b': 2, 'c~d': 2 })).toEqual([
      { path: '/a~1b', expected: 1, actual: 2 },
      { path: '/c~0d', expected: 1, actual: 2 },
    ])
  })

  it('walks deeply nested objects', () => {
    const a = { month: { categories: [{ monthly: { '2026-09': '10.00', '2026-08': '5.00' } }] } }
    const b = { month: { categories: [{ monthly: { '2026-08': '5.00', '2026-09': '11.00' } }] } }
    expect(diff(a, b)).toEqual([
      { path: '/month/categories/0/monthly/2026-09', expected: '10.00', actual: '11.00' },
    ])
  })
})

describe('compareResponses', () => {
  const ok = (body: Envelope['body']): Envelope => ({
    status: 200,
    contentType: 'application/json',
    body,
  })

  it('compares status, content type, and body', () => {
    const python: Envelope = { status: 404, contentType: 'application/problem+json', body: { status: 404 } }
    const ts: Envelope = { status: 501, contentType: 'application/json', body: { status: 501 } }
    expect(compareResponses(python, ts)).toEqual([
      { path: '/status', expected: 404, actual: 501 },
      { path: '/content_type', expected: 'application/problem+json', actual: 'application/json' },
      { path: '/body/status', expected: 404, actual: 501 },
    ])
  })

  it('normalizes both sides before diffing: microseconds vs milliseconds', () => {
    const python = ok([{ id: 1, balance_as_of: '2026-09-30T12:00:00.000123Z' }])
    const ts = ok([{ id: 1, balance_as_of: '2026-09-30T12:00:00.000Z' }])
    expect(compareResponses(python, ts)).toEqual([])
  })

  it('normalizes both sides before diffing: offsets', () => {
    const python = ok({ balance_as_of: '2026-09-30T12:00:00+00:00' })
    const ts = ok({ balance_as_of: '2026-09-30T08:00:00-04:00' })
    expect(compareResponses(python, ts)).toEqual([])
  })

  it('masks wall-clock timestamps but still reports null against a value', () => {
    expect(
      compareResponses(ok({ started_at: '2026-10-17T22:28:21.611088Z' }), ok({ started_at: '2026-10-17T22:29:40.002Z' })),
    ).toEqual([])
    expect(compareResponses(ok({ finished_at: '2026-10-17T22:28:21Z' }), ok({ finished_at: null }))).toEqual([
      {
        path: '/body/finished_at',
        expected: '<wall-clock timestamp>',
        actual: null,
        note: 'type string vs null',
      },
    ])
  })

  it('ignores the order of ties only in a documented list', () => {
    const rule: TieRule = { path: '', orderBy: 'total', tieBreak: 'category_id', reason: 'test' }
    const python = ok([
      { category_id: 3, total: '20.00' },
      { category_id: 7, total: '20.00' },
    ])
    const ts = ok([
      { category_id: 7, total: '20.00' },
      { category_id: 3, total: '20.00' },
    ])
    expect(compareResponses(python, ts, { ties: [rule] })).toEqual([])
    expect(compareResponses(python, ts)).toHaveLength(2)
  })

  it('compares non-JSON bodies as text', () => {
    const empty: Envelope = { status: 204, contentType: null, body: null }
    expect(compareResponses(empty, empty)).toEqual([])
    expect(compareResponses(empty, { status: 204, contentType: 'text/plain', body: 'x' })).toEqual([
      { path: '/content_type', expected: null, actual: 'text/plain', note: 'type null vs string' },
      { path: '/body', expected: null, actual: 'x', note: 'type null vs string' },
    ])
  })
})
