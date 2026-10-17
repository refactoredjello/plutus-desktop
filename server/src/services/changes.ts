/**
 * What changed (R12): deterministic signals about the current month. No LLM involvement.
 * Ports app/services/changes.py.
 *
 * Each signal is a rule over the shared aggregates (services/aggregates.ts), so figures match
 * the Month page. Thresholds are module constants; there is no UI to tune them in v1.
 *
 * Rewritten from Python:
 * - Percent thresholds are compared by cross-multiplying integer cents. "Usual" is
 *   `P / n` (P cents over n months), so `excess <= expected * 0.30` is `10 (nT - P) <= 3P`.
 *   Python divides in a 28-digit Decimal context, but at exact equality the quotient is
 *   always exact (equality forces P to be a multiple of n), so the comparison is identical.
 * - An impact is the exact fraction `{ num, den }`: S4 and S8 order by `(nT - P) / n`.
 * - `_pct` is `round(float(part / whole * 100))`. The exact percentage `(nT - P) * 100 / P`
 *   rounded half to even gives the same integer: a true tie is exactly representable both as
 *   a Decimal and as a float, and any other value is far from .5 compared with the 28-digit
 *   and float errors.
 * - S6's `Decimal(median(window)) * 3` keeps the half cent of an even-length median, so the
 *   threshold is computed in half cents and the expense floor is its ceiling in cents.
 * - S6's `between(amount * 0.85, amount * 1.15)` compares `amount * 100` in SQL with
 *   `85 * amount` and `115 * amount`, which are exact integers.
 * - Python's queries without ORDER BY (confirmed charges, planned entries, `id IN (...)`)
 *   order by id here; Postgres returned them in heap order, which is insertion order for
 *   rows that were never updated. The sort is stable, so this decides equal-impact ties.
 * - `money()` formats whole dollars with `,.0f`, which rounds a Decimal half to even.
 * - `string.capwords` and `str.lower` follow CPython's casing tables (pyLower, capitalize).
 * - `short_date()` uses `%b`, the C locale's English month abbreviation.
 * - `urlencode` is `quote_plus` per key and value: UTF-8 bytes, `A-Za-z0-9_.-~` kept, space
 *   as `+`, everything else `%XX`.
 */

import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { changeDismissals, manualEntries, recurrences, transactions } from '../db/schema.js'
import { type MonthKey, type PlainDate, addDays, toParts } from '../lib/dates.js'
import { type Cents, cents, divHalfEven, formatMoney, parseMoney } from '../lib/money.js'
import type { ChangeItem, ChangesRead } from '../schemas/changes.js'
import {
  type MonthTotals,
  categoryTotals,
  expenseAmounts,
  expenseIds,
  monthBounds,
  monthKey,
  monthlyTotals,
  recentActiveMonths,
} from './aggregates.js'
import { isLapsed, project } from './projection.js'
import type { RecurringCharge } from './recurring.js'
import { listTransactions } from './transactions.js'

type Transaction = typeof transactions.$inferSelect

// Thresholds (R12.2). Changing a number here changes the product; keep the PRD in sync.
// Percentages are [numerator, denominator]; dollar amounts are cents.
export const RECURRING_CHANGE_PCT = [10, 100] as const // S1
export const RECURRING_CHANGE_MIN = cents(500) // S1
export const MISSING_GRACE_DAYS = 7 // S2
export const CATEGORY_ABOVE_PCT = [30, 100] as const // S4
export const CATEGORY_ABOVE_MIN = cents(7500) // S4
export const NEW_MERCHANT_MIN = cents(20000) // S5
export const LARGE_EXPENSE_MULTIPLE = 3 // S6
export const LARGE_EXPENSE_MIN = cents(25000) // S6
export const MEDIAN_WINDOW_DAYS = 90 // S6
export const REVIEW_COUNT_MIN = 10 // S7
export const REVIEW_SINGLE_MIN = cents(10000) // S7
export const REVIEW_SCAN_LIMIT = 500 // S7: the queue is small; cap the scan
export const DISCRETIONARY_PACE_PCT = [25, 100] as const // S8
export const MAX_ITEMS = 7 // R12.3
export const DISMISSAL_RETENTION_DAYS = 90 // R12.6
export const SIMILAR_AMOUNT_PCT = [15, 100] as const // S6: a recent charge this close means it's regular
export const SIMILAR_LOOKBACK_DAYS = 100 // S6

/** A dollar impact as the exact fraction num / den cents, for ordering within a signal. */
interface Impact {
  num: number
  den: number
}

interface Item {
  signal: string
  impact: Impact
  key: string
  text: string
  amount: Cents | null
  href: string
}

const whole = (value: Cents): Impact => ({ num: value, den: 1 })

function priority(item: Item): number {
  return Number.parseInt(item.signal.slice(1), 10)
}

/** `sorted(..., key=lambda c: (c.priority, -c.impact))`: Array.sort is stable too. */
function compareItems(a: Item, b: Item): number {
  const byPriority = priority(a) - priority(b)
  if (byPriority !== 0) return byPriority
  return b.impact.num * a.impact.den - a.impact.num * b.impact.den
}

// --- formatting ------------------------------------------------------------------------------

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Whole dollars from $100 up; cents below, so "$15.49 to $22.99" stays readable. */
export function money(value: Cents): string {
  const sign = value < 0 ? '\u2212' : ''
  const v = Math.abs(value)
  if (v >= 10000) return `${sign}$${groupThousands(String(divHalfEven(cents(v), 100)))}`
  const dollars = Math.trunc(v / 100)
  return `${sign}$${groupThousands(String(dollars))}.${String(v - dollars * 100).padStart(2, '0')}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function shortDate(day: PlainDate): string {
  const { month, day: dom } = toParts(day)
  return `${MONTHS[month - 1]} ${dom}`
}

/** _cents: the absolute value in whole cents. */
function absCents(value: Cents): number {
  return Math.abs(value)
}

/** urllib.parse.quote_plus. */
function quotePlus(text: string): string {
  let out = ''
  for (const byte of new TextEncoder().encode(text)) {
    const ch = String.fromCharCode(byte)
    if (/[A-Za-z0-9_.~-]/.test(ch)) out += ch
    else if (ch === ' ') out += '+'
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** urllib.parse.urlencode over (key, value) pairs in order. */
function urlencode(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join('&')
}

/** _transactions_href: the Transactions page over [start, endExclusive) with `params` first. */
export function transactionsHref(start: PlainDate, endExclusive: PlainDate, params: Record<string, string>): string {
  const query = new Map(Object.entries(params))
  query.set('start', start)
  query.set('end', addDays(endExclusive, -1))
  return `/transactions?${urlencode([...query])}`
}

/** Characters Python's str.split() treats as whitespace. */
// oxlint-disable-next-line no-control-regex -- Python counts \x1c-\x1f as whitespace.
const PY_WHITESPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/

/**
 * Python 3.14's str.capitalize title-cases the first character where JavaScript's toUpperCase
 * upper-cases it. Generated by comparing every code point's Python `c.capitalize()` with
 * Node's `c.toUpperCase()`: the characters whose Python result differs and is not the
 * character itself, as code points (U+1F80..U+1FA7 are in TITLE_PLUS_8).
 */
const TITLE: ReadonlyMap<number, string> = new Map(
  (
    [
      [0xdf, [0x53, 0x73]],
      [0x1c4, [0x1c5]],
      [0x1c6, [0x1c5]],
      [0x1c7, [0x1c8]],
      [0x1c9, [0x1c8]],
      [0x1ca, [0x1cb]],
      [0x1cc, [0x1cb]],
      [0x1f1, [0x1f2]],
      [0x1f3, [0x1f2]],
      [0x587, [0x535, 0x582]],
      [0x1fb2, [0x1fba, 0x345]],
      [0x1fb3, [0x1fbc]],
      [0x1fb4, [0x386, 0x345]],
      [0x1fb7, [0x391, 0x342, 0x345]],
      [0x1fc2, [0x1fca, 0x345]],
      [0x1fc3, [0x1fcc]],
      [0x1fc4, [0x389, 0x345]],
      [0x1fc7, [0x397, 0x342, 0x345]],
      [0x1ff2, [0x1ffa, 0x345]],
      [0x1ff3, [0x1ffc]],
      [0x1ff4, [0x38f, 0x345]],
      [0x1ff7, [0x3a9, 0x342, 0x345]],
      [0xfb00, [0x46, 0x66]],
      [0xfb01, [0x46, 0x69]],
      [0xfb02, [0x46, 0x6c]],
      [0xfb03, [0x46, 0x66, 0x69]],
      [0xfb04, [0x46, 0x66, 0x6c]],
      [0xfb05, [0x53, 0x74]],
      [0xfb06, [0x53, 0x74]],
      [0xfb13, [0x544, 0x576]],
      [0xfb14, [0x544, 0x565]],
      [0xfb15, [0x544, 0x56b]],
      [0xfb16, [0x54e, 0x576]],
      [0xfb17, [0x544, 0x56d]],
    ] as ReadonlyArray<readonly [number, readonly number[]]>
  ).map(([cp, out]) => [cp, String.fromCodePoint(...out)]),
)

/** U+1F80..U+1F87, U+1F90..U+1F97, U+1FA0..U+1FA7 title-case to the code point + 8. */
const TITLE_PLUS_8: ReadonlyArray<readonly [number, number]> = [
  [0x1f80, 0x1f87],
  [0x1f90, 0x1f97],
  [0x1fa0, 0x1fa7],
]

/**
 * Characters Python's capitalize leaves as they are where toUpperCase changes them: title-case
 * digraphs and Greek letters with prosgegrammeni, Georgian Mkhedruli (title case is itself),
 * and letters new in Unicode 17 (U+A7CF, U+A7D3, U+A7D5, U+16EBB..U+16ED3), which Python 3.14's
 * Unicode 16 does not know.
 */
const TITLE_SELF: ReadonlyArray<readonly [number, number]> = [
  [0x1c5, 0x1c5],
  [0x1c8, 0x1c8],
  [0x1cb, 0x1cb],
  [0x1f2, 0x1f2],
  [0x10d0, 0x10fa],
  [0x10fd, 0x10ff],
  [0x1f88, 0x1f8f],
  [0x1f98, 0x1f9f],
  [0x1fa8, 0x1faf],
  [0x1fbc, 0x1fbc],
  [0x1fcc, 0x1fcc],
  [0x1ffc, 0x1ffc],
  [0xa7cf, 0xa7cf],
  [0xa7d3, 0xa7d3],
  [0xa7d5, 0xa7d5],
  [0x16ebb, 0x16ed3],
]

/** Unicode 17 capitals that toLowerCase lowers and Python 3.14's lower leaves unchanged. */
const LOWER_SELF: ReadonlyArray<readonly [number, number]> = [
  [0xa7ce, 0xa7ce],
  [0xa7d2, 0xa7d2],
  [0xa7d4, 0xa7d4],
  [0x16ea0, 0x16eb8],
]

const inRanges = (cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean =>
  ranges.some(([lo, hi]) => cp >= lo && cp <= hi)

const CASE_IGNORABLE = /^\p{Case_Ignorable}$/u
const CASED = /^\p{Cased}$/u
const CAPITAL_SIGMA = '\u03a3'

/**
 * CPython's handle_capital_sigma: U+03A3 lowers to final sigma when a cased character comes
 * before it and none after, skipping case-ignorable characters both ways.
 */
function lowerSigma(chars: readonly string[], i: number): string {
  let j = i - 1
  while (j >= 0 && CASE_IGNORABLE.test(chars[j] as string)) j -= 1
  let finalSigma = j >= 0 && CASED.test(chars[j] as string)
  if (finalSigma && i + 1 < chars.length) {
    j = i + 1
    while (j < chars.length && CASE_IGNORABLE.test(chars[j] as string)) j += 1
    finalSigma = j === chars.length || !CASED.test(chars[j] as string)
  }
  return finalSigma ? '\u03c2' : '\u03c3'
}

/** CPython's lower_ucs4 for chars[i], with the whole string as the sigma context. */
function lowerAt(chars: readonly string[], i: number): string {
  const ch = chars[i] as string
  if (ch === CAPITAL_SIGMA) return lowerSigma(chars, i)
  if (inRanges(ch.codePointAt(0) as number, LOWER_SELF)) return ch
  // Without a locale, toLowerCase is context-free for every character but capital sigma.
  return ch.toLowerCase()
}

/** Python's `str.lower()`. */
export function pyLower(text: string): string {
  const chars = Array.from(text)
  return chars.map((_, i) => lowerAt(chars, i)).join('')
}

/** The title case of one character, as `str.capitalize()` applies it to the first. */
function titleChar(ch: string): string {
  const cp = ch.codePointAt(0) as number
  const mapped = TITLE.get(cp)
  if (mapped !== undefined) return mapped
  if (inRanges(cp, TITLE_PLUS_8)) return String.fromCodePoint(cp + 8)
  if (inRanges(cp, TITLE_SELF)) return ch
  return ch.toUpperCase()
}

/** Python's `str.capitalize()`: the first character title-cased, the rest lowered. */
function capitalize(word: string): string {
  const chars = Array.from(word)
  if (chars.length === 0) return ''
  let out = titleChar(chars[0] as string)
  for (let i = 1; i < chars.length; i++) out += lowerAt(chars, i)
  return out
}

/** string.capwords: split on whitespace runs, capitalize each word, join with one space. */
export function capwords(text: string): string {
  return text
    .split(PY_WHITESPACE)
    .filter((word) => word !== '')
    .map(capitalize)
    .join(' ')
}

/** How the app displays a merchant: the latest payee, else the cleaned merchant key. */
export function merchantLabel(db: Db, merchantKey: string): string {
  const payee = db
    .select({ payee: transactions.payee })
    .from(transactions)
    .where(and(eq(transactions.merchant_key, merchantKey), isNotNull(transactions.payee)))
    .orderBy(desc(transactions.posted_on))
    .limit(1)
    .get()?.payee
  return payee || capwords(pyLower(merchantKey))
}

function txLabel(tx: Transaction): string {
  if (tx.payee) return tx.payee
  return capwords(pyLower(tx.merchant_key || tx.raw_description))
}

/** _pct(excess, expected) with excess = num / n and expected = whole / n, both positive. */
function pct(num: number, wholeNum: number): number {
  // round(float(part / whole * 100)): half to even on the exact quotient (see the header).
  return divHalfEven(cents(num * 100), wholeNum)
}

function transactionsByIds(db: Db, ids: readonly number[]): Transaction[] {
  if (ids.length === 0) return []
  return db.select().from(transactions).where(inArray(transactions.id, [...ids])).orderBy(transactions.id).all()
}

// --- signals ---------------------------------------------------------------------------------

function s1RecurringChanged(db: Db, charges: readonly RecurringCharge[]): Item[] {
  const items: Item[] = []
  for (const c of charges) {
    const latest = db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.merchant_key, c.merchant_key),
          eq(transactions.account_id, c.account_id),
          eq(transactions.pending, false),
          eq(transactions.is_transfer, false),
        ),
      )
      .orderBy(desc(transactions.posted_on), desc(transactions.id))
      .limit(1)
      .get()
    if (latest === undefined) continue
    const diff = Math.abs(latest.amount - c.amount)
    // diff <= max(|amount| * 10%, $5)
    const [pn, pd] = RECURRING_CHANGE_PCT
    if (diff * pd <= Math.abs(c.amount) * pn || diff <= RECURRING_CHANGE_MIN) continue
    const name = merchantLabel(db, c.merchant_key)
    items.push({
      signal: 'S1',
      impact: whole(cents(diff)),
      key: `S1:recurrence:${c.id}:${absCents(latest.amount)}`,
      text: `${name} went from ${money(cents(Math.abs(c.amount)))} to ${money(cents(Math.abs(latest.amount)))}.`,
      amount: cents(Math.abs(latest.amount)),
      href: '/recurring',
    })
  }
  return items
}

function s2RecurringMissing(db: Db, charges: readonly RecurringCharge[], today: PlainDate): Item[] {
  const items: Item[] = []
  for (const c of charges) {
    // Lapsed (two periods unseen) means probably cancelled: the projection already drops it.
    if (isLapsed(c, today)) continue
    const overdue = c.next_expected_date < addDays(today, -MISSING_GRACE_DAYS)
    const seenSince = c.last_seen_on !== null && c.last_seen_on >= c.next_expected_date
    if (!overdue || seenSince) continue
    const name = merchantLabel(db, c.merchant_key)
    const amount = cents(Math.abs(c.amount))
    items.push({
      signal: 'S2',
      impact: whole(amount),
      key: `S2:recurrence:${c.id}:${c.next_expected_date}`,
      text: `${name} hasn't posted; expected ${shortDate(c.next_expected_date)}.`,
      amount,
      href: '/recurring',
    })
  }
  return items
}

function s3PlannedOverdue(db: Db, today: PlainDate): Item[] {
  const entries = db
    .select()
    .from(manualEntries)
    .where(
      and(
        eq(manualEntries.recurrence, 'none'),
        isNull(manualEntries.fulfilled_transaction_id),
        lt(manualEntries.due_date, today),
      ),
    )
    .orderBy(manualEntries.id)
    .all()
  return entries.map((e) => {
    const amount = cents(Math.abs(e.amount))
    return {
      signal: 'S3',
      impact: whole(amount),
      key: `S3:entry:${e.id}:${e.due_date}`,
      text: `${e.description} (${money(amount)}) was due ${shortDate(e.due_date)} and hasn't matched a transaction.`,
      amount,
      href: '/planned',
    }
  })
}

/**
 * `day` limits the usual months to the same point in the month (null for whole months).
 *
 * Comparing with "spent by this day" rather than a prorated average keeps once-a-month
 * bills (a loan on the 1st) from looking far above pace early in the month.
 */
function s4CategoryAbove(db: Db, month: MonthKey, used: readonly MonthTotals[], day: number | null, complete: boolean): Item[] {
  if (used.length === 0) return []
  const n = used.length
  const [start, end] = monthBounds(month)
  const past = new Map(
    categoryTotals(
      db,
      used.map((m) => m.month),
      null,
      day,
    ).map((c) => [c.category_id, c]),
  )
  const items: Item[] = []
  for (const c of categoryTotals(db, [month])) {
    if (c.category_id === null) continue // Uncategorized is the Review queue's job
    const prior = past.get(c.category_id)
    // expected = P / n; excess = T - P / n = (nT - P) / n
    const p = prior ? Object.values(prior.monthly).reduce((a, b) => a + b, 0) : 0
    const excessNum = n * c.total - p
    const [pn, pd] = CATEGORY_ABOVE_PCT
    if (p <= 0 || excessNum * pd <= p * pn || excessNum <= CATEGORY_ABOVE_MIN * n) continue
    const percent = pct(excessNum, p)
    const text = complete
      ? `${c.label} was ${money(c.total)}, ${percent}% above usual.`
      : `${c.label} is ${money(c.total)} so far, ${percent}% above your usual pace.`
    items.push({
      signal: 'S4',
      impact: { num: excessNum, den: n },
      key: `S4:category:${c.category_id}:${month}`,
      text,
      amount: c.total,
      href: transactionsHref(start, end, { category: String(c.category_id) }),
    })
  }
  return items
}

function s5NewMerchants(db: Db, month: MonthKey): [Item[], Set<string>] {
  const [start, end] = monthBounds(month)
  const txs = transactionsByIds(db, expenseIds(db, start, end, NEW_MERCHANT_MIN))
  if (txs.length === 0) return [[], new Set()]
  const keys = [...new Set(txs.map((t) => t.merchant_key).filter((k): k is string => Boolean(k)))]
  const seenBefore = new Set(
    keys.length === 0
      ? []
      : db
          .selectDistinct({ key: transactions.merchant_key })
          .from(transactions)
          .where(and(inArray(transactions.merchant_key, keys), lt(transactions.posted_on, start)))
          .all()
          .map((r) => r.key),
  )
  const largest = new Map<string, Transaction>()
  for (const t of txs) {
    const key = t.merchant_key
    if (key && !seenBefore.has(key)) {
      const current = largest.get(key)
      if (current === undefined || t.amount < current.amount) largest.set(key, t)
    }
  }
  const items = [...largest].map(([key, t]): Item => {
    const amount = cents(Math.abs(t.amount))
    return {
      signal: 'S5',
      impact: whole(amount),
      key: `S5:merchant:${key}:${month}`,
      text: `First purchase at ${txLabel(t)}: ${money(amount)}.`,
      amount,
      href: transactionsHref(start, end, { q: t.payee || t.raw_description }),
    }
  })
  return [items, new Set(largest.keys())]
}

/** max(Decimal(median(window)) * 3, $250) as a floor in whole cents for `-amount >= floor`. */
function largeExpenseFloor(window: readonly Cents[]): Cents {
  const sorted = [...window].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  // The median in half cents: statistics.median's (a + b) / 2 keeps the half cent.
  const medianHalves = sorted.length % 2 === 1 ? 2 * (sorted[mid] as number) : (sorted[mid - 1] as number) + (sorted[mid] as number)
  const thresholdHalves = Math.max(medianHalves * LARGE_EXPENSE_MULTIPLE, 2 * LARGE_EXPENSE_MIN)
  return cents(Math.ceil(thresholdHalves / 2))
}

function s6LargeExpenses(
  db: Db,
  month: MonthKey,
  today: PlainDate,
  skipMerchants: ReadonlySet<string>,
  recurringKeys: ReadonlySet<string>,
): Item[] {
  const window = expenseAmounts(db, addDays(today, -MEDIAN_WINDOW_DAYS), addDays(today, 1))
  if (window.length === 0) return []
  const floor = largeExpenseFloor(window)
  const [start, end] = monthBounds(month)
  const items: Item[] = []
  for (const t of transactionsByIds(db, expenseIds(db, start, end, floor))) {
    // Known recurring charges (rent, loans) are expected, and S5 already reports new merchants.
    if (t.merchant_key !== null && (skipMerchants.has(t.merchant_key) || recurringKeys.has(t.merchant_key))) continue
    if (seenSimilarBefore(db, t, start)) continue
    const amount = cents(Math.abs(t.amount))
    items.push({
      signal: 'S6',
      impact: whole(amount),
      key: `S6:transaction:${t.id}`,
      text: `${money(amount)} to ${txLabel(t)} on ${shortDate(t.posted_on)}.`,
      amount,
      href: transactionsHref(start, end, { q: t.payee || t.raw_description }),
    })
  }
  return items
}

/** Same merchant charged within 15% of this amount in the ~3 months before this month. */
function seenSimilarBefore(db: Db, t: Transaction, monthStart: PlainDate): boolean {
  if (!t.merchant_key) return false
  // amount * (1 -/+ 0.15), in hundredths of a cent: compared with amount * 100.
  const [pn, pd] = SIMILAR_AMOUNT_PCT
  const a = t.amount * (pd - pn)
  const b = t.amount * (pd + pn)
  const [low, high] = a <= b ? [a, b] : [b, a]
  const found = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.merchant_key, t.merchant_key),
        sql`${transactions.posted_on} >= ${addDays(monthStart, -SIMILAR_LOOKBACK_DAYS)}`,
        lt(transactions.posted_on, monthStart),
        sql`${transactions.amount} * ${pd} between ${low} and ${high}`,
      ),
    )
    .limit(1)
    .get()
  return found !== undefined
}

function s7ReviewBacklog(db: Db): Item[] {
  const [rows, total] = listTransactions(db, {
    q: null,
    start: null,
    end: null,
    account_ids: null,
    category_ids: null,
    essentiality: null,
    uncategorized: false,
    needs_review: true,
    include_transfers: false,
    limit: REVIEW_SCAN_LIMIT,
    offset: 0,
  })
  if (rows.length === 0) return []
  const biggest = cents(Math.max(...rows.map((t) => Math.abs(parseMoney(t.amount)))))
  if (total < REVIEW_COUNT_MIN && biggest <= REVIEW_SINGLE_MIN) return []
  let text: string
  if (total === 1) text = `A ${money(biggest)} transaction needs review.`
  else if (biggest > REVIEW_SINGLE_MIN) text = `${total} transactions need review, including one for ${money(biggest)}.`
  else text = `${total} transactions need review.`
  return [{ signal: 'S7', impact: whole(biggest), key: `S7:review:${total}:${absCents(biggest)}`, text, amount: null, href: '/review' }]
}

function s8DiscretionaryPace(db: Db, current: MonthTotals, used: readonly MonthTotals[], day: number, month: MonthKey): Item[] {
  if (used.length === 0) return []
  const n = used.length
  const usual = monthlyTotals(
    db,
    used.map((m) => m.month),
    day,
  )
  // expected = P / n; excess = D - P / n = (nD - P) / n
  const p = usual.reduce((a, m) => a + m.discretionary, 0)
  const excessNum = n * current.discretionary - p
  const [pn, pd] = DISCRETIONARY_PACE_PCT
  if (p <= 0 || excessNum * pd <= p * pn) return []
  return [
    {
      signal: 'S8',
      impact: { num: excessNum, den: n },
      key: `S8:discretionary:${month}`,
      text: `Discretionary spending is running ${pct(excessNum, p)}% above usual.`,
      amount: null,
      href: `/spending?${urlencode([
        ['essentiality', 'discretionary'],
        ['month', month],
      ])}`,
    },
  ]
}

function s9ProjectionNegative(db: Db, month: MonthKey): Item[] {
  const endBalance = (project(db, 1).months[0] as { projected_end_balance: Cents }).projected_end_balance
  if (endBalance >= 0) return []
  // "Only when the previous projection was not" needs history we don't store; the
  // month in the key means one dismissal holds for the month (see PR notes).
  return [
    {
      signal: 'S9',
      impact: whole(cents(Math.abs(endBalance))),
      key: `S9:projection:${month}`,
      text: `Projected month-end balance is ${money(endBalance)}.`,
      amount: endBalance,
      href: '/#balance',
    },
  ]
}

// --- entry points ----------------------------------------------------------------------------

export function compute(db: Db, today: PlainDate, { includeAll = false }: { includeAll?: boolean } = {}): ChangesRead {
  const month = monthKey(today)
  const used = recentActiveMonths(db, month)
  const current = monthlyTotals(db, [month])[0] as MonthTotals
  const day = toParts(today).day

  const charges = db.select().from(recurrences).where(eq(recurrences.status, 'confirmed')).orderBy(recurrences.id).all()
  const recurringKeys = new Set(
    db
      .select({ key: recurrences.merchant_key })
      .from(recurrences)
      .where(ne(recurrences.status, 'dismissed'))
      .all()
      .map((r) => r.key),
  )
  const [s5, s5Merchants] = s5NewMerchants(db, month)
  const candidates = [
    ...s1RecurringChanged(db, charges),
    ...s2RecurringMissing(db, charges, today),
    ...s3PlannedOverdue(db, today),
    ...s4CategoryAbove(db, month, used, day, false),
    ...s5,
    ...s6LargeExpenses(db, month, today, s5Merchants, recurringKeys),
    ...s7ReviewBacklog(db),
    ...s8DiscretionaryPace(db, current, used, day, month),
    ...s9ProjectionNegative(db, month),
  ]
  const dismissed = new Set(
    db
      .select({ key: changeDismissals.key })
      .from(changeDismissals)
      .all()
      .map((r) => r.key),
  )
  const visible = candidates.filter((c) => !dismissed.has(c.key)).sort(compareItems)
  const shown = includeAll ? visible : visible.slice(0, MAX_ITEMS)
  return {
    as_of: today,
    average_months: used.length,
    items: shown.map(
      (c): ChangeItem => ({
        signal: c.signal,
        key: c.key,
        text: c.text,
        amount: c.amount === null ? null : formatMoney(c.amount),
        href: c.href,
      }),
    ),
    hidden: visible.length - shown.length,
  }
}

/** Hide an item until its fact changes. */
export function dismiss(db: Db, key: string): void {
  const existing = db.select({ key: changeDismissals.key }).from(changeDismissals).where(eq(changeDismissals.key, key)).get()
  if (existing === undefined) {
    // key.split(":", 1)[0][:10], sliced by code point as Python slices a str.
    const signal = Array.from(key.split(':')[0] as string)
      .slice(0, 10)
      .join('')
    db.insert(changeDismissals).values({ key, signal }).run()
  }
}

export function clearDismissals(db: Db): void {
  db.delete(changeDismissals).run()
}

/**
 * prune_dismissals: drop dismissals older than the retention window and return how many.
 * `now` is an ISO 8601 UTC timestamp, default the current instant. Does not open a transaction.
 */
export function pruneDismissals(db: Db, now?: string): number {
  const nowMs = now === undefined ? Date.now() : Date.parse(now)
  const cutoff = new Date(nowMs - DISMISSAL_RETENTION_DAYS * 86_400_000).toISOString()
  // A string comparison: every dismissed_at (SQL default, 2D importer) has toISOString()'s shape.
  return db.delete(changeDismissals).where(lt(changeDismissals.dismissed_at, cutoff)).returning({ key: changeDismissals.key }).all()
    .length
}
