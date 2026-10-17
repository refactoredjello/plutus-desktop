/**
 * Cash projection (R7): current balance plus planned flows minus variable spending.
 * Ports app/services/projection.py.
 *
 * Python's trailing averages are unquantized Decimals (`total / days` in the default context:
 * 28 significant digits, half even), multiplied by a day count and only then quantized to
 * cents. That intermediate rounding decides ties: 0.01 / 6 * 3 is exactly 0.005, which one
 * half-even division rounds to 0.00, but Python's 0.001666...667 * 3 quantizes to 0.01. So a
 * rate is kept as the exact fraction `total / days`, and `rateTimes` replays the Decimal
 * context steps on integers (BigInt, as 28 digits exceed a double).
 */

import { eq, gt, isNull, min, or } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { type Cadence, manualEntries, recurrences, transactions } from '../db/schema.js'
import { type PlainDate, addDays, daysBetween, daysInMonth, fromParts, toParts } from '../lib/dates.js'
import { type Cents, ZERO, cents, formatMoney } from '../lib/money.js'
import { currentTotalBalance, expensesBetween, incomeBetween } from './aggregates.js'
import type { RecurringCharge } from './recurring.js'
import { occurrences, today as scheduleToday } from './schedule.js'

export const TRAILING_DAYS = 90
export const LAPSE_GRACE_DAYS = 7
export const CADENCE_DAYS: Readonly<Record<Cadence, number>> = {
  weekly: 7,
  biweekly: 14,
  semimonthly: 15,
  monthly: 30,
  yearly: 365,
}

/** ProjectedMonth, in cents; the route formats it. */
export interface ProjectedMonth {
  month: string
  starting_balance: Cents
  recurring_income: Cents
  recurring_expenses: Cents
  manual_income: Cents
  manual_expenses: Cents
  variable_spending: Cents
  variable_income: Cents
  projected_end_balance: Cents
}

/** ProjectionRead, in cents. */
export interface Projection {
  as_of: PlainDate
  current_balance: Cents
  months: ProjectedMonth[]
  assumptions: string[]
}

/** A daily average as the exact fraction Python divided: `max(total, 0) / days`. */
export interface DailyRate {
  total: Cents
  days: number
}

/** Not seen for two cadence periods plus a grace period: probably cancelled. */
export function isLapsed(charge: Pick<RecurringCharge, 'last_seen_on' | 'cadence'>, today: PlainDate): boolean {
  if (charge.last_seen_on === null) return false
  const limit = 2 * CADENCE_DAYS[charge.cadence] + LAPSE_GRACE_DAYS
  return daysBetween(charge.last_seen_on, today) > limit
}

// --- Decimal context arithmetic ----------------------------------------------------------------

const PRECISION = 28
const TEN = 10n

function digits(n: bigint): number {
  return n.toString().length
}

/** n / d rounded half to even; n >= 0, d > 0. */
function divRound(n: bigint, d: bigint): bigint {
  const q = n / d
  const r = n % d
  if (2n * r > d || (2n * r === d && q % 2n === 1n)) return q + 1n
  return q
}

/** A non-negative decimal coefficient * 10^exponent, in cents. */
interface Dec {
  coefficient: bigint
  exponent: number
}

/** Round to the context precision, half to even (what every Decimal operation does). */
function toPrecision(value: Dec): Dec {
  const extra = digits(value.coefficient) - PRECISION
  if (extra <= 0) return value
  return { coefficient: divRound(value.coefficient, TEN ** BigInt(extra)), exponent: value.exponent + extra }
}

/** `Decimal(total) / days`: the correctly rounded 28-digit quotient. */
function contextDivide(rate: DailyRate): Dec {
  if (rate.total === 0) return { coefficient: 0n, exponent: 0 }
  let n = BigInt(rate.total)
  const d = BigInt(rate.days)
  let exponent = 0
  // Scale until the quotient has 28 digits; a safe integer numerator never starts above that.
  while (n / d < TEN ** BigInt(PRECISION - 1)) {
    n *= TEN
    exponent -= 1
  }
  // A carry to 10^28 has a trailing zero; the value is what matters for what follows.
  return { coefficient: divRound(n, d), exponent }
}

/** `value.quantize(Decimal("0.00"))`: to whole cents, half to even. */
function quantizeCents(value: Dec): Cents {
  if (value.exponent >= 0) return cents(Number(value.coefficient * TEN ** BigInt(value.exponent)))
  return cents(Number(divRound(value.coefficient, TEN ** BigInt(-value.exponent))))
}

/** `_cents(rate * days)`: the 28-digit quotient times days, rounded to 28 digits, then cents. */
export function rateTimes(rate: DailyRate, days: number): Cents {
  const q = contextDivide(rate)
  return quantizeCents(toPrecision({ coefficient: q.coefficient * BigInt(days), exponent: q.exponent }))
}

/** `_cents(rate)`: the daily figure quoted in the assumptions. */
export function rateCents(rate: DailyRate): Cents {
  return quantizeCents(contextDivide(rate))
}

// --- Projection --------------------------------------------------------------------------------

/** Days of history behind the average: at most 90, fewer for a new database. */
export function coveredDays(db: Db, today: PlainDate): number {
  const row = db
    .select({ earliest: min(transactions.posted_on) })
    .from(transactions)
    .where(eq(transactions.is_transfer, false))
    .get()
  const earliest = row?.earliest ?? null
  if (earliest === null) return TRAILING_DAYS
  return Math.max(1, Math.min(TRAILING_DAYS, daysBetween(earliest as PlainDate, today)))
}

/**
 * Trailing expenses (aggregates' definition) outside confirmed recurring merchants and
 * owner-marked one-time transactions.
 */
export function variableDailyAverage(
  db: Db,
  today: PlainDate,
  excludedKeys: Iterable<string>,
  days: number = TRAILING_DAYS,
): DailyRate {
  const total = expensesBetween(db, addDays(today, -(TRAILING_DAYS - 1)), addDays(today, 1), excludedKeys, {
    excludeOneTime: true,
  })
  return { total: total > 0 ? total : ZERO, days }
}

/** Trailing income outside confirmed recurring items, e.g. a paycheck not yet confirmed. */
export function variableDailyIncome(
  db: Db,
  today: PlainDate,
  excludedKeys: Iterable<string>,
  days: number = TRAILING_DAYS,
): DailyRate {
  const total = incomeBetween(db, addDays(today, -(TRAILING_DAYS - 1)), addDays(today, 1), excludedKeys)
  return { total: total > 0 ? total : ZERO, days }
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

export function project(db: Db, months = 3): Projection {
  const today = scheduleToday()
  const allConfirmed = db.select().from(recurrences).where(eq(recurrences.status, 'confirmed')).all()
  const confirmed = allConfirmed.filter((c) => !isLapsed(c, today))
  const lapsed = allConfirmed.length - confirmed.length
  const entries = db
    .select()
    .from(manualEntries)
    .where(or(isNull(manualEntries.end_date), gt(manualEntries.end_date, today)))
    .all()
    .filter((e) => e.fulfilled_transaction_id === null && (e.recurrence !== 'none' || e.due_date > today))
  const window = coveredDays(db, today)
  // Lapsed merchants stay excluded from variable spending: they are still recurring ones.
  const recurringKeys = new Set(allConfirmed.map((c) => c.merchant_key))
  const daily = variableDailyAverage(db, today, recurringKeys, window)
  const dailyIncome = variableDailyIncome(db, today, recurringKeys, window)

  const current = currentTotalBalance(db)
  let balance = current
  const out: ProjectedMonth[] = []
  let { year, month } = toParts(today)
  for (let index = 0; index < months; index += 1) {
    const last = fromParts(year, month, daysInMonth(year, month))
    const after = index === 0 ? today : addDays(fromParts(year, month, 1), -1)
    const days = daysBetween(after, last)

    let recIn = 0
    let recOut = 0
    let manIn = 0
    let manOut = 0
    for (const c of confirmed) {
      for (const _ of occurrences(c.next_expected_date, c.cadence, after, last)) {
        if (c.amount > 0) recIn += c.amount
        else recOut -= c.amount
      }
    }
    for (const e of entries) {
      for (const day of occurrences(e.due_date, e.recurrence, after, last)) {
        if (e.end_date !== null && day > e.end_date) break
        if (e.amount > 0) manIn += e.amount
        else manOut -= e.amount
      }
    }
    const variable = rateTimes(daily, days)
    const variableIn = rateTimes(dailyIncome, days)
    const start = balance
    balance = cents(start + recIn + manIn + variableIn - recOut - manOut - variable)
    out.push({
      month: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
      starting_balance: start,
      recurring_income: cents(recIn),
      recurring_expenses: cents(recOut),
      manual_income: cents(manIn),
      manual_expenses: cents(manOut),
      variable_spending: variable,
      variable_income: variableIn,
      projected_end_balance: balance,
    })
    if (month === 12) {
      year += 1
      month = 1
    } else {
      month += 1
    }
  }

  const assumptions = [
    `Variable spending averages $${formatMoney(rateCents(daily))}/day over the last ${window} days` +
      (window < TRAILING_DAYS ? ' (all the history there is)' : '') +
      ', excluding transfers, confirmed recurring charges, and one-time transactions.',
    `Other income averages $${formatMoney(rateCents(dailyIncome))}/day over the same period. Confirm ` +
      'paychecks on the Recurring page to project them on their actual dates.',
    `${confirmed.length} confirmed recurring ` +
      `${plural(confirmed.length, 'item is', 'items are')} included at their usual amounts ` +
      'and cadence.',
    `${entries.length} planned manual ` +
      `${plural(entries.length, 'entry is', 'entries are')} included on their due dates.`,
    'The current month counts only days after today.',
  ]
  if (lapsed) {
    assumptions.splice(
      2,
      0,
      `${lapsed} confirmed recurring item(s) left out because they haven't appeared recently.`,
    )
  }
  return { as_of: today, current_balance: current, months: out, assumptions }
}
