/**
 * Merchant key scrubbing, plus cases for each place where the Unicode-aware patterns differ
 * from native JavaScript `RegExp` (the "Unicode-aware patterns" block).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMoney } from '../src/lib/money.js'
import { amountBucket, buildMerchantInput, merchantKey } from '../src/services/scrub.js'
import { OWNER_TOKENS } from './factories.js'
import { FIXTURES } from './setup.js'

interface GoldenCase {
  raw: string
  expected_key: string | null
  must_not_contain: string[]
}

const GOLDEN = JSON.parse(readFileSync(join(FIXTURES, 'scrub_golden.json'), 'utf8')) as GoldenCase[]

/** A digit is any Unicode decimal digit; JavaScript's `\d` is ASCII only. */
function assertInvariants(key: string): void {
  expect(key, key).not.toMatch(/\p{Nd}{4,}/u)
  expect(OWNER_TOKENS.some((t) => key.toUpperCase().includes(t)), key).toBe(false)
  expect(key).toBe(key.toUpperCase())
  expect(key).toBeTruthy()
}

describe('golden', () => {
  it('has every fixture case', () => {
    expect(GOLDEN).toHaveLength(29)
  })

  it.each(GOLDEN.map((c) => [c.raw, c] as const))('%s', (_raw, c) => {
    const key = merchantKey(c.raw, OWNER_TOKENS)
    if (c.expected_key !== null) expect(key).toBe(c.expected_key)
    for (const forbidden of c.must_not_contain) expect(key).not.toContain(forbidden)
    assertInvariants(key)
  })
})

describe('invariants on awkward input', () => {
  it.each([
    'card 4111 1111 1111 1111 purchase',
    "ALEXANDER SAMPLEVILLE ALEX'S DINER",
    'pp*Some Seller 8005551234',
    'PAYMENT 2026-03-04 TRACE # 99887766',
    'VENMO CASHOUT JANE DOE',
    'ZELLE PAYMENT FROM Alex Sample 12345',
    'STORE 12 CHARGE (415) 555-0100',
    '1234567',
  ])('%s', (raw) => {
    assertInvariants(merchantKey(raw, OWNER_TOKENS))
  })
})

it('normalizes whitespace and case', () => {
  expect(merchantKey('  trader   joe s  ', [])).toBe('TRADER JOE S')
})

it('gives the same key across store numbers', () => {
  const a = merchantKey('TRADER JOE S #552 OAKLAND CA', [])
  const b = merchantKey('TRADER JOE S #101 OAKLAND CA', [])
  expect(a).toBe(b)
})

it('defaults to no owner tokens', () => {
  expect(merchantKey('  trader   joe s  ')).toBe('TRADER JOE S')
})

describe('amountBucket', () => {
  it.each([
    ['-3.50', '<10'],
    ['10.00', '10-50'],
    ['-49.99', '10-50'],
    ['50', '50-200'],
    ['-199.99', '50-200'],
    ['200', '200-1000'],
    ['-1000', '200-1000'],
    ['1000.01', '>1000'],
  ])('%s is %s', (amount, bucket) => {
    expect(amountBucket(parseMoney(amount))).toBe(bucket)
  })
})

it('builds merchant input', () => {
  const item = buildMerchantInput('NETFLIX.COM CA', parseMoney('-15.49'), 'credit')
  expect([item.amount_bucket, item.direction, item.account_kind]).toEqual(['10-50', 'outflow', 'credit'])
  expect(item.merchant_key).toBe('NETFLIX.COM CA')
  expect(buildMerchantInput('X', parseMoney('5'), 'savings').direction).toBe('inflow')
})

describe('Unicode-aware patterns', () => {
  const cp = (...points: number[]): string => String.fromCodePoint(...points)
  const E_ACUTE = cp(0xc9)
  /** Arabic-Indic digits one to five: Unicode decimal digits, not ASCII. */
  const AR = cp(0x661, 0x662, 0x663, 0x664, 0x665)
  /** MATHEMATICAL BOLD CAPITAL A: one code point, two UTF-16 units. */
  const BOLD_A = cp(0x1d400)

  // A word boundary treats every Unicode letter and digit as a word character; a native
  // JavaScript `\b` sees only [A-Za-z0-9_], so it would find a boundary next to the E-acute
  // and fire the VENMO, masked-account, reference, ZELLE, and PayPal passes.
  it.each([
    [`CAFE${E_ACUTE}VENMO PAYMENT JANE DOE`, `CAFE${E_ACUTE}VENMO PAYMENT JANE DOE`],
    [`CAFE${E_ACUTE}XX12`, `CAFE${E_ACUTE}XX12`],
    [`CAFE${E_ACUTE}REF NO 12`, `CAFE${E_ACUTE}REF NO 12`],
    [`ZELLE TO${E_ACUTE} BOB`, `ZELLE TO${E_ACUTE} BOB`],
    [`CAFE${E_ACUTE}ZELLE TO BOB`, `CAFE${E_ACUTE}ZELLE TO BOB`],
    [`PAYPAL INST XFER${E_ACUTE} BOB`, `PAYPAL INST XFER${E_ACUTE} BOB`],
  ])('\\b is Unicode-aware: %j', (raw, expected) => {
    expect(merchantKey(raw, [])).toBe(expected)
  })

  // A digit is any Unicode decimal digit; a native JavaScript `\d` would leave
  // these digit runs (and break the four-digit invariant).
  it.each([
    [`STORE ${AR}`, 'STORE'],
    [`CARD ${AR.slice(0, 2)} ${AR.slice(2, 4)} ${AR.slice(4)}9`, 'CARD'],
    [`SHOP ${AR.slice(0, 3)}-${AR.slice(0, 3)}-${AR.slice(0, 3)}${AR.slice(0, 1)}`, 'SHOP'],
    [`AMZN*${AR.slice(0, 2)}Q`, `AMZN ${AR.slice(1, 2)}Q`],
    [`SHOP 12${AR.slice(0, 1)}4`, 'SHOP'],
  ])('\\d is Unicode-aware: %j', (raw, expected) => {
    expect(merchantKey(raw, [])).toBe(expected)
  })

  // Whitespace includes U+001C..U+001F and U+0085 but not U+FEFF;
  // JavaScript's `\s` and trim() are the other way round.
  it.each([
    [`TRADER${cp(0x1c)}JOE${cp(0x85)}S`, 'TRADER JOE S'],
    [`${cp(0xfeff)}NETFLIX`, `${cp(0xfeff)}NETFLIX`],
    [`SQ${cp(0x1f)}*${cp(0x1f)}BLUE BOTTLE`, 'BLUE BOTTLE'],
    [`CVS${cp(0x2028)}PHARMACY${cp(0x2029)}#12${cp(0x0d)}X`, 'CVS PHARMACY X'],
  ])('whitespace includes U+001C..U+001F and U+0085, not U+FEFF: %j', (raw, expected) => {
    expect(merchantKey(raw, [])).toBe(expected)
  })

  // Lengths and slices count code points; JavaScript strings count UTF-16 units.
  it('truncates at 200 code points', () => {
    const group = `${BOLD_A.repeat(4)} `
    const key = merchantKey(group.repeat(50), [])
    expect(key).toBe(group.repeat(40).trimEnd())
  })

  it.each([
    [`${BOLD_A} DINER`, [BOLD_A], `${BOLD_A} DINER`],
    [`${BOLD_A}${BOLD_A} DINER`, [`${BOLD_A}${BOLD_A}`], 'DINER'],
  ])('owner token length counts code points: %j', (raw, tokens, expected) => {
    expect(merchantKey(raw, tokens)).toBe(expected)
  })

  // Owner tokens: stripped of whitespace, regex-escaped, length-filtered before upper-casing,
  // longest first.
  it.each([
    ['AL DINER', [`${cp(0x1c)}al${cp(0x1c)}`], 'DINER'],
    ['AXB A.B CAFE', ['a.b'], 'AXB CAFE'],
    ['MARY ANN BAKERY', ['Mary Ann'], 'BAKERY'],
    ['JO-ANN FABRICS', ['jo-ann'], 'FABRICS'],
    ['ALEXANDRA ALEX DINER', ['alex', 'alexandra'], 'DINER'],
    ['STRASSE CAFE', [cp(0xdf)], 'STRASSE CAFE'],
    ['BIG (A) STORE', ['(a)'], 'BIG STORE'],
  ])('owner tokens: %j minus %j', (raw, tokens, expected) => {
    expect(merchantKey(raw, tokens)).toBe(expected)
  })

  it('uppercases with full case mapping', () => {
    expect(merchantKey(`stra${cp(0xdf)}e cafe`, [])).toBe('STRASSE CAFE')
  })
})
