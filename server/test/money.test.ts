import { describe, expect, it } from 'vitest'
import {
  type Cents,
  cents,
  divHalfEven,
  formatMoney,
  median,
  mulRatioHalfEven,
  parseMoney,
  sum,
} from '../src/lib/money.js'

const c = (n: number): Cents => cents(n)

describe('parseMoney', () => {
  it.each([
    ['123.45', 12345],
    ['-15.49', -1549],
    ['0.00', 0],
    ['-0.00', 0],
    ['0', 0],
    ['12', 1200],
    ['12.5', 1250],
    ['+3.10', 310],
    ['.5', 50],
    ['7.', 700],
    [' 42.00 ', 4200],
    ['999999999999.99', 99999999999999],
  ])('parses %j as %d cents', (text, expected) => {
    expect(parseMoney(text)).toBe(expected)
  })

  // Extra digits round half away from zero (stored amounts' rule).
  it.each([
    ['1.005', 101],
    ['1.004', 100],
    ['-1.005', -101],
    ['2.675', 268],
    ['0.125', 13],
  ])('rounds %j to two places, half away from zero: %d', (text, expected) => {
    expect(parseMoney(text)).toBe(expected)
  })

  it.each(['', 'abc', '1,000.00', '1e3', '--1', '12.3.4', 'NaN', 'Infinity', '.'])(
    'rejects %j',
    (text) => {
      expect(() => parseMoney(text)).toThrow()
    },
  )

  it('rejects values beyond the safe integer range', () => {
    expect(() => parseMoney('900719925474099.99')).toThrow()
  })
})

describe('formatMoney', () => {
  it.each([
    [12345, '123.45'],
    [-1549, '-15.49'],
    [0, '0.00'],
    [5, '0.05'],
    [-5, '-0.05'],
    [-100, '-1.00'],
    [100000000, '1000000.00'],
  ])('formats %d as %j', (value, expected) => {
    expect(formatMoney(c(value))).toBe(expected)
  })

  it('formats negative zero without a sign', () => {
    expect(formatMoney(c(-0))).toBe('0.00')
  })

  it('round-trips through parseMoney', () => {
    for (const text of ['-15.49', '0.01', '123456.78', '-0.99']) {
      expect(formatMoney(parseMoney(text))).toBe(text)
    }
  })
})

describe('cents', () => {
  it('accepts safe integers', () => {
    expect(cents(42)).toBe(42)
  })

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'refuses %d',
    (value) => {
      expect(() => cents(value)).toThrow()
    },
  )
})

describe('divHalfEven', () => {
  it.each([
    // exact
    [100, 4, 25],
    [-100, 4, -25],
    // plain rounding
    [10, 3, 3],
    [20, 3, 7],
    [-10, 3, -3],
    [-20, 3, -7],
    // ties go to the even neighbour
    [5, 2, 2],
    [7, 2, 4],
    [15, 10, 2],
    [25, 10, 2],
    [35, 10, 4],
    [-5, 2, -2],
    [-7, 2, -4],
    [-25, 10, -2],
    [-35, 10, -4],
    [1, 2, 0],
    [-1, 2, 0],
    [3, 2, 2],
    // negative divisor
    [5, -2, -2],
    [7, -2, -4],
    [-7, -2, 4],
  ])('%d / %d = %d', (value, divisor, expected) => {
    expect(divHalfEven(c(value), divisor)).toBe(expected)
  })

  it('never returns negative zero', () => {
    expect(Object.is(divHalfEven(c(-1), 3), -0)).toBe(false)
    expect(Object.is(divHalfEven(c(-1), 2), -0)).toBe(false)
  })

  it('is exact near the safe integer limit', () => {
    const big = Number.MAX_SAFE_INTEGER - 1 // even
    expect(divHalfEven(c(big), 2)).toBe(big / 2)
    expect(divHalfEven(c(big - 1), 2)).toBe((big - 2) / 2) // tie, rounds to even
  })

  it('refuses a zero or fractional divisor', () => {
    expect(() => divHalfEven(c(1), 0)).toThrow()
    expect(() => divHalfEven(c(1), 1.5)).toThrow()
  })
})

describe('mulRatioHalfEven', () => {
  it.each([
    [1000, 1, 3, 333],
    [1000, 2, 3, 667],
    [150, 1, 4, 38], // 37.5 -> 38 (even)
    [130, 1, 4, 32], // 32.5 -> 32 (even)
    [-150, 1, 4, -38],
    [-130, 1, 4, -32],
    [1999, 12, 1, 23988],
    [1999, 52, 12, 8662], // 8662.33
    [1, 1, 2, 0],
  ])('%d * %d / %d = %d', (value, num, den, expected) => {
    expect(mulRatioHalfEven(c(value), num, den)).toBe(expected)
  })

  it('refuses a product beyond the safe integer range', () => {
    expect(() => mulRatioHalfEven(c(Number.MAX_SAFE_INTEGER), 2, 2)).toThrow()
  })
})

describe('median', () => {
  it('takes the middle of an odd list, unsorted input', () => {
    expect(median([c(300), c(100), c(200)])).toBe(200)
  })

  it('takes the single value of a one-item list', () => {
    expect(median([c(1549)])).toBe(1549)
  })

  it('takes the mean of the two middle values of an even list', () => {
    expect(median([c(100), c(400), c(300), c(200)])).toBe(250)
  })

  it('rounds the even-list mean half to even', () => {
    // (1001 + 1002) / 2 = 1001.5 -> 1002; (1000 + 1001) / 2 = 1000.5 -> 1000
    expect(median([c(1001), c(1002)])).toBe(1002)
    expect(median([c(1000), c(1001)])).toBe(1000)
    expect(median([c(-1001), c(-1002)])).toBe(-1002)
    expect(median([c(-1000), c(-1001)])).toBe(-1000)
  })

  it('sorts numerically, not as strings', () => {
    expect(median([c(9), c(10), c(100)])).toBe(10)
  })

  it('does not mutate its input', () => {
    const values = [c(3), c(1), c(2)]
    median(values)
    expect(values).toEqual([3, 1, 2])
  })

  it('refuses an empty list like statistics.median', () => {
    expect(() => median([])).toThrow()
  })
})

describe('sum', () => {
  it('adds integer cents', () => {
    expect(sum([c(10), c(-3), c(250)])).toBe(257)
  })

  it('is zero for an empty list', () => {
    expect(sum([])).toBe(0)
  })

  it('has no float drift', () => {
    // 0.1 + 0.2 as floats is 0.30000000000000004; as cents it is exact.
    expect(formatMoney(sum([parseMoney('0.10'), parseMoney('0.20')]))).toBe('0.30')
  })
})
