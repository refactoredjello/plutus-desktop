/**
 * Report data for the dashboard (R4). Ports api/app/services/reports.py.
 *
 * Like the Python service, functions return the response schemas, so money leaves here as the
 * wire string (formatMoney) and routes stay thin.
 */

import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { type EssentialityFilter, accounts, balanceSnapshots, transactions } from '../db/schema.js'
import { type MonthKey, type PlainDate, addDays, plainDate, today } from '../lib/dates.js'
import { DomainError } from '../lib/errors.js'
import { type Cents, cents, formatMoney } from '../lib/money.js'
import type { AccountBalanceSeries, BalancePoint, CategoryTotal, MonthlySummary } from '../schemas/reports.js'
import { categoryTotals, monthRange, monthlyTotals } from './aggregates.js'

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
 * balance(d) = B - sum(amounts posted in (d, D]); days after D carry B.
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
    // snap.as_of.date(): timestamps are stored as ISO 8601 UTC, and the Python session is UTC.
    const snapDay = plainDate(snap.as_of.slice(0, 10))
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
          sql`${transactions.posted_on} > ${first}`,
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
    while (day >= first) {
      points.push({ on: day, balance: formatMoney(cents(snap.balance - after)) })
      after += daily.get(day) ?? 0
      day = addDays(day, -1)
    }
    points.reverse()
    out.push({ account_id: account.id, name: account.name, points })
  }
  return out
}
