/**
 * Recurring charge detection and management (R6).
 *
 * detectRecurring is called by services/sync.ts after categorization. Keep its signature stable.
 */

import { and, asc, eq, gte, isNotNull, ne } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import {
  type Cadence,
  type Essentiality,
  type RecurrenceStatus,
  categorizations,
  recurrences,
  transactions,
} from '../db/schema.js'
import { type PlainDate, daysBetween, toParts } from '../lib/dates.js'
import { DomainError, NotFoundError } from '../lib/errors.js'
import { type Cents, cents, median } from '../lib/money.js'
import { MONTH_END_FROM, addMonths, nextAfter, today } from './schedule.js'

export type RecurringCharge = typeof recurrences.$inferSelect

export const MIN_OCCURRENCES = 3
export const LOOKBACK_MONTHS = 18
/** Amount tolerance 0.15, as a ratio of integers for cross-multiplication. */
const TOLERANCE_NUMERATOR = 15
const TOLERANCE_DENOMINATOR = 100
/** Allowed gap in days between consecutive occurrences, per cadence (checked in this order). */
export const GAP_BANDS: ReadonlyArray<readonly [Cadence, number, number]> = [
  ['weekly', 6, 8],
  ['biweekly', 13, 15],
  ['monthly', 27, 33],
  ['yearly', 350, 380],
]
export const PER_YEAR: Readonly<Record<Cadence, number>> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  yearly: 1,
}

/** Amount times occurrences per year, signed like the amount. */
export function annualCost(charge: Pick<RecurringCharge, 'amount' | 'cadence'>): Cents {
  return cents(charge.amount * PER_YEAR[charge.cadence])
}

const SEMIMONTHLY_GAPS = [12, 19] as const
const SEMIMONTHLY_SPREAD = 2 // max spread in days of month inside each of the two clusters

const total = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0)

/**
 * True when days of month form two tight clusters about half a month apart.
 *
 * Days of 28+ count as month end (30). A true biweekly series drifts through the month,
 * so it never forms two clusters.
 */
function isSemimonthlyDays(dates: readonly PlainDate[]): boolean {
  const days = [...new Set(dates.map((d) => toParts(d).day).map((day) => (day >= MONTH_END_FROM ? 30 : day)))].sort(
    (a, b) => a - b,
  )
  if (days.length < 2) return false
  // max(range(1, len(days)), key=gap): the first index with the largest gap.
  let cut = 1
  for (let i = 2; i < days.length; i += 1) {
    if ((days[i] as number) - (days[i - 1] as number) > (days[cut] as number) - (days[cut - 1] as number)) cut = i
  }
  const low = days.slice(0, cut)
  const high = days.slice(cut)
  if (Math.max(...low) - Math.min(...low) > SEMIMONTHLY_SPREAD || Math.max(...high) - Math.min(...high) > SEMIMONTHLY_SPREAD) {
    return false
  }
  // Float means: the day numbers are small integers, so the result is deterministic.
  const centers = total(high) / high.length - total(low) / low.length
  return centers >= 12 && centers <= 19
}

/** The median of integers: the middle value, or the mean of the two middle values. */
function medianNumber(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/**
 * The cadence whose band holds the median gap and most (all but a quarter) of the gaps.
 *
 * Semimonthly is decided first: gaps mostly 12-19 days and days of month in two clusters.
 */
export function detectCadence(dates: readonly PlainDate[]): Cadence | null {
  const gaps: number[] = []
  for (let i = 1; i < dates.length; i += 1) gaps.push(daysBetween(dates[i - 1] as PlainDate, dates[i] as PlainDate))
  if (gaps.length === 0) return null
  const [lowGap, highGap] = SEMIMONTHLY_GAPS
  const inBand = gaps.filter((g) => lowGap <= g && g <= highGap).length
  if (inBand * 4 >= gaps.length * 3 && isSemimonthlyDays(dates)) return 'semimonthly'
  const mid = medianNumber(gaps)
  for (const [cadence, low, high] of GAP_BANDS) {
    if (low <= mid && mid <= high) {
      const inside = gaps.filter((g) => low <= g && g <= high).length
      return inside * 4 >= gaps.length * 3 ? cadence : null
    }
  }
  return null
}

/**
 * At least three quarters of amounts within 15% of the median.
 *
 * Like gaps, this tolerates the odd outlier, e.g. a paycheck that includes a bonus.
 *
 * The comparison is against the unrounded median, which can end in half a cent, so the
 * median is kept doubled (twice the middle value, or the sum of the two middle values) so the
 * comparison stays exact in integers: |a - mid| <= |mid| * 15/100 becomes
 * |2a - 2mid| * 100 <= |2mid| * 15.
 */
export function amountsConsistent(amounts: readonly Cents[]): boolean {
  const sorted = [...amounts].sort((a, b) => a - b)
  const m = Math.floor(sorted.length / 2)
  const mid2 =
    sorted.length % 2 === 1 ? 2 * (sorted[m] as number) : (sorted[m - 1] as number) + (sorted[m] as number)
  if (mid2 === 0) return false
  const close = amounts.filter(
    (a) => Math.abs(2 * a - mid2) * TOLERANCE_DENOMINATOR <= Math.abs(mid2) * TOLERANCE_NUMERATOR,
  ).length
  return close * 4 >= amounts.length * 3
}

type Item = readonly [PlainDate, Cents]

/**
 * Keep only the majority sign: a refund or reversal is not part of a bill's or paycheck's
 * pattern. Ties keep outflows.
 */
function dominantDirection(items: readonly Item[]): Item[] {
  const inflows = items.filter((i) => i[1] > 0)
  const outflows = items.filter((i) => i[1] < 0)
  return inflows.length > outflows.length ? inflows : outflows
}

const groupKey = (merchantKey: string, accountId: number): string => JSON.stringify([merchantKey, accountId])

/**
 * Propose or refresh recurring charges from transaction history.
 *
 * Returns the number of recurrences created or updated. Does not open a transaction; the
 * caller decides.
 */
export function detectRecurring(db: Db): number {
  const rows = db
    .select({
      merchant_key: transactions.merchant_key,
      account_id: transactions.account_id,
      posted_on: transactions.posted_on,
      amount: transactions.amount,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.is_transfer, false),
        eq(transactions.pending, false),
        isNotNull(transactions.merchant_key),
        gte(transactions.posted_on, addMonths(today(), -LOOKBACK_MONTHS)),
      ),
    )
    .orderBy(asc(transactions.posted_on), asc(transactions.id))
    .all()
  const groups = new Map<string, { key: string; accountId: number; items: Item[] }>()
  for (const row of rows) {
    if (row.merchant_key === null) continue
    const k = groupKey(row.merchant_key, row.account_id)
    let group = groups.get(k)
    if (group === undefined) {
      group = { key: row.merchant_key, accountId: row.account_id, items: [] }
      groups.set(k, group)
    }
    group.items.push([row.posted_on, row.amount])
  }

  const existing = new Map<string, RecurringCharge>()
  for (const r of db.select().from(recurrences).all()) existing.set(groupKey(r.merchant_key, r.account_id), r)
  const essentiality = latestEssentiality(db)
  let changed = 0
  for (const [k, { key, accountId, items: allItems }] of groups) {
    const items = dominantDirection(allItems)
    const found = existing.get(k)
    if (found !== undefined && found.status === 'dismissed') continue
    const dates = items.map(([d]) => d)
    const amounts = items.map(([, a]) => a)
    const cadence = items.length >= MIN_OCCURRENCES ? detectCadence(dates) : null
    if (cadence === null || !amountsConsistent(amounts)) {
      // Too few or irregular to detect, e.g. a yearly fee the owner marked by hand.
      // Still keep an existing recurrence's dates current.
      const lastDate = dates.at(-1)
      if (
        found !== undefined &&
        lastDate !== undefined &&
        (found.last_seen_on === null || lastDate > found.last_seen_on)
      ) {
        db.update(recurrences)
          .set({ last_seen_on: lastDate, next_expected_date: nextAfter(lastDate, found.cadence) })
          .where(eq(recurrences.id, found.id))
          .run()
        changed += 1
      }
      continue
    }
    const amount = median(amounts.slice(-3))
    const last = dates.at(-1) as PlainDate
    if (found === undefined) {
      db.insert(recurrences)
        .values({
          merchant_key: key,
          account_id: accountId,
          amount,
          cadence,
          next_expected_date: nextAfter(last, cadence),
          last_seen_on: last,
          status: 'proposed',
          essentiality: essentiality.get(key) ?? null,
        })
        .run()
      changed += 1
      continue
    }
    const patch: Partial<typeof recurrences.$inferInsert> = {}
    const nxt = nextAfter(last, found.cadence)
    if (found.amount !== amount || found.last_seen_on !== last || found.next_expected_date !== nxt) {
      Object.assign(patch, { amount, last_seen_on: last, next_expected_date: nxt })
      changed += 1
    }
    const ess = essentiality.get(key)
    if (found.essentiality === null && ess !== undefined) {
      patch.essentiality = ess
      changed += 1
    }
    if (Object.keys(patch).length > 0) {
      db.update(recurrences).set(patch).where(eq(recurrences.id, found.id)).run()
    }
  }
  return changed
}

/** Essentiality of each merchant's most recent categorized transaction. */
function latestEssentiality(db: Db): Map<string, Essentiality> {
  const out = new Map<string, Essentiality>()
  const rows = db
    .select({ key: transactions.merchant_key, value: categorizations.essentiality })
    .from(transactions)
    .innerJoin(categorizations, eq(categorizations.transaction_id, transactions.id))
    .where(and(isNotNull(transactions.merchant_key), isNotNull(categorizations.essentiality)))
    .orderBy(asc(transactions.posted_on), asc(transactions.id))
    .all()
  for (const { key, value } of rows) {
    if (key !== null && value !== null) out.set(key, value) // later rows overwrite earlier ones
  }
  return out
}

/**
 * Confirm a transaction's merchant as recurring at `cadence`.
 *
 * For charges detection can't find on its own: yearly fees, or too little history.
 * Re-marking an existing (even dismissed) recurrence updates and confirms it.
 */
export function markRecurring(db: Db, transactionId: number, cadence: Cadence): RecurringCharge {
  const tx = db.select().from(transactions).where(eq(transactions.id, transactionId)).get()
  if (tx === undefined) throw new NotFoundError(`Transaction ${transactionId} not found`)
  if (tx.is_transfer) throw new DomainError("Transfers between your accounts can't be recurring charges.")
  if (!tx.merchant_key) throw new DomainError('This transaction has no merchant yet; categorize it first.')
  const merchantKey = tx.merchant_key
  let nxt = nextAfter(tx.posted_on, cadence)
  while (nxt <= today()) nxt = nextAfter(nxt, cadence)
  const categorization = db
    .select({ essentiality: categorizations.essentiality })
    .from(categorizations)
    .where(eq(categorizations.transaction_id, tx.id))
    .get()
  const values = {
    amount: tx.amount,
    cadence,
    last_seen_on: tx.posted_on,
    next_expected_date: nxt,
    status: 'confirmed' as const,
    ...(categorization?.essentiality != null ? { essentiality: categorization.essentiality } : {}),
  }
  return db.transaction((t) => {
    const charge = t
      .select({ id: recurrences.id })
      .from(recurrences)
      .where(and(eq(recurrences.merchant_key, merchantKey), eq(recurrences.account_id, tx.account_id)))
      .get()
    if (charge === undefined) {
      return t
        .insert(recurrences)
        .values({ merchant_key: merchantKey, account_id: tx.account_id, ...values })
        .returning()
        .get()
    }
    return t.update(recurrences).set(values).where(eq(recurrences.id, charge.id)).returning().get()
  })
}

export function listRecurring(db: Db, status: RecurrenceStatus | null = null): RecurringCharge[] {
  return db
    .select()
    .from(recurrences)
    .where(status === null ? ne(recurrences.status, 'dismissed') : eq(recurrences.status, status))
    .orderBy(asc(recurrences.next_expected_date), asc(recurrences.id))
    .all()
}

/**
 * `body.model_dump(exclude_unset=True)`: a key that is absent was not sent; a key that is null
 * was sent as null.
 */
export interface RecurringChanges {
  status?: RecurrenceStatus | null
  essentiality?: Essentiality | null
  amount?: Cents | null
  cadence?: Cadence | null
}

/** Apply a partial update. Changing the cadence recomputes the next expected date. */
export function updateRecurring(db: Db, recurringId: number, changes: RecurringChanges): RecurringCharge {
  const charge = db.select().from(recurrences).where(eq(recurrences.id, recurringId)).get()
  if (charge === undefined) throw new NotFoundError(`Recurring charge ${recurringId} not found`)
  const patch: Partial<typeof recurrences.$inferInsert> = {}
  if (changes.status != null) patch.status = changes.status
  if (changes.amount != null) patch.amount = changes.amount
  if (changes.cadence != null) patch.cadence = changes.cadence
  // `"essentiality" in changes`: JSON has no undefined, so a sent key is never undefined.
  if (changes.essentiality !== undefined) patch.essentiality = changes.essentiality
  if (changes.cadence != null) {
    patch.next_expected_date = nextAfter(charge.last_seen_on ?? charge.next_expected_date, changes.cadence)
  }
  if (Object.keys(patch).length === 0) return charge
  return db.update(recurrences).set(patch).where(eq(recurrences.id, recurringId)).returning().get()
}
