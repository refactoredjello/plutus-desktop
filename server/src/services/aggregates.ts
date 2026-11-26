/**
 * Shared monthly totals.
 *
 * Orchestrator-owned: reports, projection, and goals all build on these definitions.
 *
 * Definitions, applied everywhere:
 * - Transfers between owned accounts (is_transfer) are excluded entirely.
 * - Money movement is excluded too, even when the other side is not paired: credit card
 *   payments (spending is counted when the purchase posts on the card), account, savings,
 *   and investment transfers. See MONEY_MOVEMENT. Peer-to-peer apps, wires, withdrawals, and
 *   loan payments stay counted: that money really leaves.
 * - Income: money in whose category is INCOME or TRANSFER_IN (e.g. deposits), or that is not
 *   categorized yet.
 * - Expenses: everything else, as a positive number. A refund in a spending category
 *   (money in, non-income category) reduces expenses instead of counting as income.
 * - Months are calendar months of posted_on, formatted YYYY-MM.
 *
 * SQL notes (dates are TEXT YYYY-MM-DD):
 * - The month of posted_on is `substr(posted_on, 1, 7)`.
 * - The day of the month is `cast(substr(posted_on, 9, 2) as integer)`.
 * - The latest snapshot per account is
 *   `row_number() over (partition by account_id order by as_of desc, id desc) = 1`.
 * - Money is integer cents, so sums are exact.
 */

import { type SQL, and, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import {
  type Essentiality,
  type EssentialityFilter,
  accounts,
  balanceSnapshots,
  categories,
  categorizations,
  transactions,
} from '../db/schema.js'
import { type MonthKey, type PlainDate, addDays, monthBounds, monthKey, toParts } from '../lib/dates.js'
import { type Cents, ZERO, cents } from '../lib/money.js'

export { ZERO, monthBounds, monthKey }

export const INCOME_PRIMARIES = ['INCOME', 'TRANSFER_IN'] as const
export const MONEY_MOVEMENT = [
  'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
  'TRANSFER_IN_ACCOUNT_TRANSFER',
  'TRANSFER_OUT_ACCOUNT_TRANSFER',
  'TRANSFER_IN_SAVINGS',
  'TRANSFER_OUT_SAVINGS',
  'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS',
  'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
] as const

export interface MonthTotals {
  readonly month: MonthKey
  readonly income: Cents
  readonly expenses: Cents
  readonly essential: Cents
  readonly flexible: Cents
  readonly discretionary: Cents
  readonly uncategorized: Cents
  /** income - expenses. */
  readonly net: Cents
}

type MonthValues = Omit<MonthTotals, 'month' | 'net'>

/** MonthTotals(month, ...): every total defaults to zero; net is derived. */
export function monthTotals(month: MonthKey, values: Partial<MonthValues> = {}): MonthTotals {
  const v: MonthValues = {
    income: values.income ?? ZERO,
    expenses: values.expenses ?? ZERO,
    essential: values.essential ?? ZERO,
    flexible: values.flexible ?? ZERO,
    discretionary: values.discretionary ?? ZERO,
    uncategorized: values.uncategorized ?? ZERO,
  }
  return { month, ...v, net: cents(v.income - v.expenses) }
}

export interface CategoryMonthTotal {
  readonly category_id: number | null
  readonly label: string
  readonly primary: string | null
  /** Expenses, positive. */
  readonly total: Cents
  readonly count: number
  /** Per-month totals, in the order months were first seen. */
  readonly monthly: Record<MonthKey, Cents>
}

interface CategoryAcc {
  label: string
  primary: string | null
  count: number
  monthly: Record<MonthKey, Cents>
}

/** The `months` calendar months ending with the month of `end`, oldest first. */
export function monthRange(end: PlainDate, months: number): MonthKey[] {
  let { year, month } = toParts(end)
  const out: MonthKey[] = []
  for (let i = 0; i < months; i++) {
    out.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`)
    month -= 1
    if (month === 0) {
      year -= 1
      month = 12
    }
  }
  return out.reverse()
}

function isIncome(): SQL {
  return and(
    sql`${transactions.amount} > 0`,
    or(isNull(categorizations.category_id), inArray(categories.primary, [...INCOME_PRIMARIES])),
  ) as SQL
}

function notIncome(): SQL {
  return sql`not (${isIncome()})`
}

/** The amount as a positive expense; money that counts as income contributes nothing. */
function expenseAmount(): SQL {
  return sql`case when ${isIncome()} then 0 else -${transactions.amount} end`
}

/** _base: the WHERE every aggregate shares, over transactions outer-joined to categories. */
function baseConditions(start: PlainDate, endExclusive: PlainDate): SQL[] {
  return [
    eq(transactions.is_transfer, false),
    or(isNull(categories.detailed), notInArray(categories.detailed, [...MONEY_MOVEMENT])) as SQL,
    sql`${transactions.posted_on} >= ${start}`,
    sql`${transactions.posted_on} < ${endExclusive}`,
  ]
}

// select ... from transactions left join categorizations left join categories: the joins of
// _base, spelled out in each query because Drizzle cannot type a join over generic fields.
const categorizationJoin = () => eq(categorizations.transaction_id, transactions.id)
const categoryJoin = () => eq(categories.id, categorizations.category_id)

/** Only days 1..`day` of each month: "spent by this point in the month". */
function throughDayCondition(day: number | null | undefined): SQL {
  return day !== null && day !== undefined
    ? sql`cast(substr(${transactions.posted_on}, 9, 2) as integer) <= ${day}`
    : sql`1 = 1`
}

const monthCol = () => sql<string>`substr(${transactions.posted_on}, 1, 7)`

const money = (expr: SQL) => sql`coalesce(sum(${expr}), 0)`.mapWith((v: number) => cents(Number(v)))

/**
 * Totals for each month in `months` (YYYY-MM, oldest first), zero-filled.
 *
 * `throughDay` limits each month to its first N days, for same-point-in-month pace.
 */
export function monthlyTotals(db: Db, months: readonly MonthKey[], throughDay: number | null = null): MonthTotals[] {
  const first = months[0]
  const last = months[months.length - 1]
  if (first === undefined || last === undefined) return []
  const [start] = monthBounds(first)
  const [, end] = monthBounds(last)
  const income = isIncome()
  const byEssentiality = (value: Essentiality | null) => {
    const cond = value === null ? isNull(categorizations.essentiality) : eq(categorizations.essentiality, value)
    return money(sql`case when ${cond} then ${expenseAmount()} else 0 end`)
  }
  const rows = db
    .select({
      month: monthCol(),
      income: money(sql`case when ${income} then ${transactions.amount} else 0 end`),
      expenses: money(expenseAmount()),
      essential: byEssentiality('essential'),
      flexible: byEssentiality('flexible'),
      discretionary: byEssentiality('discretionary'),
      uncategorized: byEssentiality(null),
    })
    .from(transactions)
    .leftJoin(categorizations, categorizationJoin())
    .leftJoin(categories, categoryJoin())
    .where(and(...baseConditions(start, end), throughDayCondition(throughDay)))
    .groupBy(monthCol())
    .all()
  const found = new Map(rows.map(({ month, ...values }) => [month, monthTotals(month, values)]))
  return months.map((m) => found.get(m) ?? monthTotals(m))
}

/** SQL condition on Categorization (outer-joined) for an essentiality filter. */
export function essentialityCondition(value: EssentialityFilter): SQL {
  if (value === 'unset') return isNull(categorizations.essentiality)
  return eq(categorizations.essentiality, value)
}

/**
 * Expenses per category over `months`, with a per-month breakdown. Largest first.
 *
 * Uncategorized spending is one row with category_id null. `essentiality` narrows to one
 * bucket; `unset` covers spending with no essentiality, including uncategorized spending.
 */
export function categoryTotals(
  db: Db,
  months: readonly MonthKey[],
  essentiality: EssentialityFilter | null = null,
  throughDay: number | null = null,
): CategoryMonthTotal[] {
  const first = months[0]
  const last = months[months.length - 1]
  if (first === undefined || last === undefined) return []
  const [start] = monthBounds(first)
  const [, end] = monthBounds(last)
  const rows = db
    .select({
      category_id: categories.id,
      label: categories.label,
      primary: categories.primary,
      month: monthCol(),
      total: sql`sum(-${transactions.amount})`.mapWith((v: number) => cents(Number(v))),
      count: sql`count(${transactions.id})`.mapWith(Number),
    })
    .from(transactions)
    .leftJoin(categorizations, categorizationJoin())
    .leftJoin(categories, categoryJoin())
    .where(
      and(
        ...baseConditions(start, end),
        throughDayCondition(throughDay),
        notIncome(),
        essentiality ? essentialityCondition(essentiality) : sql`1 = 1`,
      ),
    )
    .groupBy(categories.id, categories.label, categories.primary, monthCol())
    .all()
  const acc = new Map<number | null, CategoryAcc>()
  for (const { category_id, label, primary, month, total, count } of rows) {
    let entry = acc.get(category_id)
    if (entry === undefined) {
      entry = { label: label || 'Uncategorized', primary, count: 0, monthly: {} }
      acc.set(category_id, entry)
    }
    entry.count += count
    entry.monthly[month] = total
  }
  const out: CategoryMonthTotal[] = [...acc].map(([category_id, e]) => ({
    category_id,
    label: e.label,
    primary: e.primary,
    total: cents(Object.values(e.monthly).reduce((a, b) => a + b, 0)),
    count: e.count,
    monthly: e.monthly,
  }))
  // Largest first; the sort is stable, so equal totals keep their first-seen order.
  return out.sort((a, b) => b.total - a.total)
}

/** Sum of each active account's latest snapshot balance. Credit balances are negative. */
export function currentTotalBalance(db: Db): Cents {
  const latest = db
    .select({
      balance: balanceSnapshots.balance,
      rn: sql<number>`row_number() over (partition by ${balanceSnapshots.account_id} order by ${balanceSnapshots.as_of} desc, ${balanceSnapshots.id} desc)`.as(
        'rn',
      ),
    })
    .from(balanceSnapshots)
    .innerJoin(accounts, eq(accounts.id, balanceSnapshots.account_id))
    .where(eq(accounts.is_active, true))
    .as('latest')
  const row = db
    .select({ total: sql`coalesce(sum(${latest.balance}), 0)`.mapWith(Number) })
    .from(latest)
    .where(sql`${latest.rn} = 1`)
    .get()
  return cents(row?.total ?? 0)
}

function excludeKeys(keys: readonly string[]): SQL {
  return or(isNull(transactions.merchant_key), notInArray(transactions.merchant_key, [...keys])) as SQL
}

/**
 * Total expenses (positive) posted in [start, endExclusive), optionally skipping merchants.
 *
 * `excludeOneTime` drops owner-marked one-offs: for a "what do I usually spend" figure,
 * not for totals of what was actually spent.
 */
export function expensesBetween(
  db: Db,
  start: PlainDate,
  endExclusive: PlainDate,
  excludeMerchantKeys: Iterable<string> = [],
  { excludeOneTime = false }: { excludeOneTime?: boolean } = {},
): Cents {
  const conds = baseConditions(start, endExclusive)
  const keys = [...excludeMerchantKeys]
  if (keys.length > 0) conds.push(excludeKeys(keys))
  if (excludeOneTime) conds.push(eq(transactions.one_time, false))
  const row = db
    .select({ total: money(expenseAmount()) })
    .from(transactions)
    .leftJoin(categorizations, categorizationJoin())
    .leftJoin(categories, categoryJoin())
    .where(and(...conds))
    .get()
  return row?.total ?? ZERO
}

/** Total income posted in [start, endExclusive), optionally skipping merchants. */
export function incomeBetween(
  db: Db,
  start: PlainDate,
  endExclusive: PlainDate,
  excludeMerchantKeys: Iterable<string> = [],
): Cents {
  const conds = baseConditions(start, endExclusive)
  const keys = [...excludeMerchantKeys]
  if (keys.length > 0) conds.push(excludeKeys(keys))
  const row = db
    .select({ total: money(sql`case when ${isIncome()} then ${transactions.amount} else 0 end`) })
    .from(transactions)
    .leftJoin(categorizations, categorizationJoin())
    .leftJoin(categories, categoryJoin())
    .where(and(...conds))
    .get()
  return row?.total ?? ZERO
}

/** Ids of the largest expenses (aggregates' definition) posted in [start, endExclusive). */
export function largestExpenseIds(db: Db, start: PlainDate, endExclusive: PlainDate, limit = 5): number[] {
  return db
    .select({ id: transactions.id })
    .from(transactions)
    .leftJoin(categorizations, categorizationJoin())
    .leftJoin(categories, categoryJoin())
    .where(and(...baseConditions(start, endExclusive), notIncome(), sql`${transactions.amount} < 0`))
    .orderBy(sql`${transactions.amount} asc`, sql`${transactions.id} asc`)
    .limit(limit)
    .all()
    .map((r) => r.id)
}

/** Ids of income (aggregates' definition) posted in [start, endExclusive), largest first. */
export function incomeIds(db: Db, start: PlainDate, endExclusive: PlainDate): number[] {
  return db
    .select({ id: transactions.id })
    .from(transactions)
    .leftJoin(categorizations, categorizationJoin())
    .leftJoin(categories, categoryJoin())
    .where(and(...baseConditions(start, endExclusive), isIncome()))
    .orderBy(sql`${transactions.amount} desc`, sql`${transactions.id} asc`)
    .all()
    .map((r) => r.id)
}

export const AVERAGE_MONTHS = 3
export const LOOKBACK_FOR_AVERAGE = 12

/**
 * Up to `n` months before `month` that had any activity, oldest first.
 *
 * "Usual" everywhere (Month page, What changed) means the average of these, so a short
 * history isn't diluted by empty months.
 */
export function recentActiveMonths(db: Db, month: MonthKey, n: number = AVERAGE_MONTHS): MonthTotals[] {
  const [start] = monthBounds(month)
  const prior = monthlyTotals(db, monthRange(addDays(start, -1), LOOKBACK_FOR_AVERAGE))
  const active = prior.filter((m) => m.income !== 0 || m.expenses !== 0)
  // The last n, or all of them when n exceeds the length; n = 0 means all of them.
  return n === 0 ? active : active.slice(-n)
}

function expensesConditions(start: PlainDate, endExclusive: PlainDate): SQL[] {
  return [...baseConditions(start, endExclusive), notIncome(), sql`${transactions.amount} < 0`]
}

/** Ids of expenses of at least `minAmount` in [start, endExclusive), largest first. */
export function expenseIds(db: Db, start: PlainDate, endExclusive: PlainDate, minAmount: Cents = ZERO): number[] {
  return db
    .select({ id: transactions.id })
    .from(transactions)
    .leftJoin(categorizations, categorizationJoin())
    .leftJoin(categories, categoryJoin())
    .where(and(...expensesConditions(start, endExclusive), sql`-${transactions.amount} >= ${minAmount}`))
    .orderBy(sql`${transactions.amount} asc`, sql`${transactions.id} asc`)
    .all()
    .map((r) => r.id)
}

/** Positive expense amounts in [start, endExclusive), for medians and percentiles. */
export function expenseAmounts(db: Db, start: PlainDate, endExclusive: PlainDate): Cents[] {
  return db
    .select({ amount: sql`-${transactions.amount}`.mapWith((v: number) => cents(Number(v))) })
    .from(transactions)
    .leftJoin(categorizations, categorizationJoin())
    .leftJoin(categories, categoryJoin())
    .where(and(...expensesConditions(start, endExclusive)))
    .all()
    .map((r) => r.amount)
}
