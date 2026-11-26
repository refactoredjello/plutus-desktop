/**
 * Report data for the dashboard.
 *
 * Functions return the response schemas, so money leaves here as the
 * wire string (formatMoney) and routes stay thin.
 */

import { and, count, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import {
  type EssentialityFilter,
  accounts,
  balanceSnapshots,
  categorizations,
  transactions,
} from '../db/schema.js'
import {
  type MonthKey,
  type PlainDate,
  addDays,
  daysBetween,
  monthBounds,
  monthKey,
  plainDate,
  toParts,
  today,
} from '../lib/dates.js'
import { DomainError } from '../lib/errors.js'
import { type Cents, ZERO, cents, divHalfEven, formatMoney, sum } from '../lib/money.js'
import type { EssentialityShare, MonthCategory, MonthDetail } from '../schemas/month.js'
import type { TransactionRead } from '../schemas/transactions.js'
import type { AccountBalanceSeries, BalancePoint, CategoryTotal, MonthlySummary } from '../schemas/reports.js'
import {
  type CategoryMonthTotal,
  categoryTotals,
  incomeIds,
  largestExpenseIds,
  monthRange,
  monthlyTotals,
  recentActiveMonths,
} from './aggregates.js'
import { listTransactions, toTransactionRead } from './transactions.js'

export const DEFAULT_HISTORY_DAYS = 180

export function monthlySummary(db: Db, months: number): MonthlySummary[] {
  return monthlyTotals(db, monthRange(today(), months)).map((t) => ({
    month: t.month,
    income: formatMoney(t.income),
    expenses: formatMoney(t.expenses),
    net: formatMoney(t.net),
    essential: formatMoney(t.essential),
    flexible: formatMoney(t.flexible),
    discretionary: formatMoney(t.discretionary),
    uncategorized: formatMoney(t.uncategorized),
  }))
}

/** `if not 1 <= int(month[5:7]) <= 12: raise DomainError(f"Invalid month {month!r}")`. */
function checkMonth(month: MonthKey): void {
  const mon = Number(month.slice(5, 7))
  if (!(mon >= 1 && mon <= 12)) throw new DomainError(`Invalid month '${month}'`)
}

export function spendingByCategory(
  db: Db,
  month: MonthKey,
  essentiality: EssentialityFilter | null = null,
): CategoryTotal[] {
  checkMonth(month)
  return categoryTotals(db, [month], essentiality).map((c) => ({
    category_id: c.category_id,
    label: c.label,
    primary: c.primary,
    total: formatMoney(c.total),
    count: c.count,
  }))
}

/**
 * Daily balance per active account, rebuilt backwards from its latest snapshot.
 *
 * Snapshots are sparse (one per sync), so for a snapshot balance B on day D:
 * balance(d) = B - sum(posted amounts in (d, D]); days after D carry B. Pending
 * transactions are left out, as the bank's ledger balance usually leaves them out.
 * A series starts at the account's earliest posted transaction or snapshot when
 * that is later than `start`; an account with no data by `end` has no series.
 */
export function balanceHistory(
  db: Db,
  start: PlainDate | null = null,
  end: PlainDate | null = null,
): AccountBalanceSeries[] {
  const last = end || today()
  const first = start || addDays(last, -DEFAULT_HISTORY_DAYS)
  if (first > last) return []
  const active = db.select().from(accounts).where(eq(accounts.is_active, true)).orderBy(accounts.id).all()
  const out: AccountBalanceSeries[] = []
  for (const account of active) {
    const snap = db
      .select()
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.account_id, account.id))
      .orderBy(desc(balanceSnapshots.as_of), desc(balanceSnapshots.id))
      .limit(1)
      .get()
    if (snap === undefined) continue
    // The snapshot's UTC date: timestamps are stored as ISO 8601 UTC.
    const snapDay = plainDate(snap.as_of.slice(0, 10))
    const firstSnap = db
      .select({ as_of: sql<string>`min(${balanceSnapshots.as_of})` })
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.account_id, account.id))
      .get()
    const firstTx = db
      .select({ on: sql<PlainDate | null>`min(${transactions.posted_on})` })
      .from(transactions)
      .where(and(eq(transactions.account_id, account.id), eq(transactions.pending, false)))
      .get()
    const firstSnapDay = plainDate((firstSnap?.as_of ?? snap.as_of).slice(0, 10))
    const firstTxDay = firstTx?.on ?? null
    const opened = firstTxDay !== null && firstTxDay < firstSnapDay ? firstTxDay : firstSnapDay
    const from = opened > first ? opened : first
    if (from > last) continue
    const daily = new Map<string, Cents>()
    const rows = db
      .select({
        posted_on: transactions.posted_on,
        total: sql`sum(${transactions.amount})`.mapWith((v: number) => cents(Number(v))),
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.account_id, account.id),
          eq(transactions.pending, false),
          sql`${transactions.posted_on} > ${from}`,
          sql`${transactions.posted_on} <= ${snapDay}`,
        ),
      )
      .groupBy(transactions.posted_on)
      .all()
    for (const { posted_on, total } of rows) daily.set(posted_on, total)
    let after = 0
    for (const [k, v] of daily) if (k > last) after += v
    const points: BalancePoint[] = []
    let day = last
    while (day >= from) {
      points.push({ on: day, balance: formatMoney(cents(snap.balance - after)) })
      after += daily.get(day) ?? 0
      day = addDays(day, -1)
    }
    points.reverse()
    out.push({ account_id: account.id, name: account.name, points })
  }
  return out
}

/** Significant digits a ratio is rounded to before it becomes a double. */
const DECIMAL_PRECISION = 28

/**
 * a / b for two cent amounts (the scales cancel) as a double: the exact quotient rounded half
 * to even to 28 significant digits, then parsed to the nearest double. Long division on safe
 * integers; |b| * 10 must stay safe.
 */
function decimalQuotient(a: Cents, b: Cents): number {
  if (b === 0) throw new RangeError('division by zero')
  const negative = a < 0 !== b < 0
  const num = Math.abs(a)
  const den = Math.abs(b)
  if (!Number.isSafeInteger(den * 10)) throw new RangeError(`Divisor out of range: ${b}`)
  let whole = Math.floor(num / den)
  while (whole * den > num) whole -= 1
  while ((whole + 1) * den <= num) whole += 1
  let rem = num - whole * den
  // The whole part's digits, then fraction digits until there are 28 significant digits and
  // one more to round on, or until the division is exact.
  const digits = whole === 0 ? [] : [...String(whole)].map(Number)
  let intLength = digits.length
  let significant = intLength
  while (rem !== 0 && significant <= DECIMAL_PRECISION) {
    rem *= 10
    const digit = Math.floor(rem / den)
    rem -= digit * den
    digits.push(digit)
    if (significant > 0 || digit > 0) significant += 1
  }
  if (significant > DECIMAL_PRECISION) {
    // Half to even on the last kept digit; a non-zero remainder means past the half.
    const guard = digits.pop() ?? 0
    const last = digits.at(-1) ?? 0
    if (guard > 5 || (guard === 5 && (rem !== 0 || last % 2 === 1))) {
      let i = digits.length - 1
      while (i >= 0 && digits[i] === 9) {
        digits[i] = 0
        i -= 1
      }
      if (i >= 0) {
        digits[i] = (digits[i] ?? 0) + 1
      } else {
        digits.unshift(1)
        intLength += 1
      }
    }
  }
  const intPart = digits.slice(0, intLength).join('') || '0'
  const fracPart = digits.slice(intLength).join('')
  const value = Number(fracPart ? `${intPart}.${fracPart}` : intPart)
  return negative ? -value : value
}

/**
 * x rounded to 4 decimals: half to even on the double's exact value. A tie at the
 * fourth decimal means x * 20000 is an odd integer, which holds exactly when x * 32 is an odd
 * integer; anything else rounds to nearest, which toFixed does exactly.
 */
function round4(x: number): number {
  const times32 = x * 32
  if (Number.isInteger(times32) && times32 % 2 !== 0) {
    const low = Math.floor(x * 10000)
    return (low % 2 === 0 ? low : low + 1) / 10000
  }
  return Number(x.toFixed(4))
}

/** a / b for cent amounts, as a double rounded to 4 decimals: how report ratios are computed. */
export function roundedRatio(a: Cents, b: Cents): number {
  return round4(decimalQuotient(a, b))
}

/** _rate. */
function rate(net: Cents, income: Cents): number | null {
  return income > 0 ? roundedRatio(net, income) : null
}

/** These transactions as TransactionRead, in the order of `ids`. */
function transactionReads(db: Db, ids: readonly number[]): TransactionRead[] {
  if (ids.length === 0) return []
  const rows = db
    .select()
    .from(transactions)
    .leftJoin(categorizations, eq(categorizations.transaction_id, transactions.id))
    .where(inArray(transactions.id, [...ids]))
    .all()
  const byId = new Map(rows.map((row) => [row.transactions.id, toTransactionRead(row.transactions, row.categorizations)]))
  return ids.flatMap((i) => {
    const t = byId.get(i)
    return t === undefined ? [] : [t]
  })
}

export function monthDetail(db: Db, month: MonthKey): MonthDetail {
  checkMonth(month)
  const now = today()
  if (month > monthKey(now)) throw new DomainError("That month hasn't started yet.")
  const [start, end] = monthBounds(month)
  const daysInMonth = daysBetween(start, end)
  const isComplete = month < monthKey(now)
  const daysElapsed = isComplete ? daysInMonth : toParts(now).day

  // Averages use up to three prior months that have any activity, so a short history
  // isn't diluted by empty months.
  const used = recentActiveMonths(db, month)
  const n = used.length

  const avg = (values: readonly Cents[]): Cents | null => (n ? divHalfEven(sum(values), n) : null)
  const money = (value: Cents | null) => (value === null ? null : formatMoney(value))

  const [self] = monthlyTotals(db, [month])
  if (self === undefined) throw new Error('monthly_totals returned no row')
  const incomeAvg = avg(used.map((m) => m.income))
  const netAvg = avg(used.map((m) => m.net))

  const buckets: [EssentialityShare['essentiality'], Cents][] = [
    ['essential', self.essential],
    ['flexible', self.flexible],
    ['discretionary', self.discretionary],
    ['unset', self.uncategorized],
  ]
  const categoryAvgs = new Map<number | null, CategoryMonthTotal>(
    categoryTotals(
      db,
      used.map((m) => m.month),
    ).map((c) => [c.category_id, c]),
  )
  const categories: MonthCategory[] = categoryTotals(db, [month]).map((c) => {
    const past = categoryAvgs.get(c.category_id)
    return {
      category_id: c.category_id,
      label: c.label,
      primary: c.primary,
      total: formatMoney(c.total),
      count: c.count,
      average: money(past ? avg(Object.values(past.monthly)) : n ? ZERO : null),
    }
  })

  const largest = transactionReads(db, largestExpenseIds(db, start, end))
  const incomeTransactions = transactionReads(db, incomeIds(db, start, end))
  const [, reviewCount] = listTransactions(db, {
    q: null,
    start,
    end: addDays(end, -1),
    account_ids: null,
    category_ids: null,
    essentiality: null,
    uncategorized: false,
    needs_review: true,
    include_transfers: false,
    limit: 1,
    offset: 0,
  })
  const transactionCount =
    db
      .select({ n: count() })
      .from(transactions)
      .where(
        and(
          eq(transactions.pending, false),
          eq(transactions.is_transfer, false),
          sql`${transactions.posted_on} >= ${start}`,
          sql`${transactions.posted_on} < ${end}`,
        ),
      )
      .get()?.n ?? 0

  return {
    month,
    is_complete: isComplete,
    days_elapsed: daysElapsed,
    days_in_month: daysInMonth,
    average_months: n,
    income: formatMoney(self.income),
    income_average: money(incomeAvg),
    expenses: formatMoney(self.expenses),
    expenses_average: money(avg(used.map((m) => m.expenses))),
    net: formatMoney(self.net),
    net_average: money(netAvg),
    savings_rate: rate(self.net, self.income),
    savings_rate_average: netAvg !== null && incomeAvg ? rate(netAvg, incomeAvg) : null,
    essentiality: buckets.map(([essentiality, total]) => ({
      essentiality,
      total: formatMoney(total),
      share: self.expenses ? roundedRatio(total, self.expenses) : 0.0,
    })),
    categories,
    largest,
    income_transactions: incomeTransactions,
    transaction_count: transactionCount,
    review_count: reviewCount,
  }
}
