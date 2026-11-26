/**
 * Pending transactions: how far back a sync reaches for them and their posted twins. The
 * owner's own way out (mark posted, remove) is in services/transactions.ts.
 *
 * - A sync requests at most PENDING_REACH_DAYS back for a pending row, so the reach never
 *   costs a second SimpleFIN request (one request covers MAX_WINDOW_DAYS, today included).
 *   A pending row dated before the reach can no longer be checked with the bank: the sync
 *   drops it only when it has an unambiguous posted twin, else it stays pending and needs review.
 * - A twin is a posted row in the same account with the same amount, dated within TWIN_DAYS.
 *   A pair counts only when each side has exactly one candidate; anything else is ambiguous.
 * - Dropping a pending row for its twin carries the owner's edits over (manual categorization,
 *   note, one_time) without overwriting a manual value already on the twin.
 * - A row the owner marked posted stays posted until the bank itself returns its external id
 *   as pending again (the bank's word wins; a later clean sync that no longer returns it then
 *   drops it as any pending row).
 */

import { and, eq, inArray, lt } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { categorizations, transactions } from '../db/schema.js'
import { type PlainDate, addDays, daysBetween, today, utcNow } from '../lib/dates.js'
import { MAX_WINDOW_DAYS } from '../providers/bank/simplefin.js'

export const PENDING_REACH_DAYS = MAX_WINDOW_DAYS - 1
export const TWIN_DAYS = 7

type Tx = typeof transactions.$inferSelect

/** The oldest date a sync on `day` reaches back to for a pending row. */
export function pendingReachStart(day: PlainDate): PlainDate {
  return addDays(day, -PENDING_REACH_DAYS)
}

export const STALE_PENDING_REASON = `Pending for over ${PENDING_REACH_DAYS} days`

/** Why a row needs review beyond its categorization, or null. */
export function reviewReason(tx: Pick<Tx, 'pending' | 'posted_on'>): string | null {
  return tx.pending && tx.posted_on < pendingReachStart(today()) ? STALE_PENDING_REASON : null
}

/** SQL for a pending row past the reach (the review queue's extra reason). */
export function stalePendingCondition() {
  return and(eq(transactions.pending, true), lt(transactions.posted_on, pendingReachStart(today())))
}

/**
 * Pair pending rows with posted twins among `candidates`; returns pending id -> twin id for
 * the unambiguous pairs only.
 */
export function findTwins(pending: readonly Tx[], candidates: readonly Tx[]): Map<number, number> {
  const options = new Map<number, Tx[]>()
  const claims = new Map<number, number>()
  for (const p of pending) {
    const found = candidates.filter(
      (c) =>
        !c.pending &&
        c.id !== p.id &&
        c.account_id === p.account_id &&
        c.amount === p.amount &&
        Math.abs(daysBetween(p.posted_on, c.posted_on)) <= TWIN_DAYS,
    )
    options.set(p.id, found)
    for (const c of found) claims.set(c.id, (claims.get(c.id) ?? 0) + 1)
  }
  const pairs = new Map<number, number>()
  for (const [id, found] of options) {
    if (found.length === 1 && claims.get(found[0]!.id) === 1) pairs.set(id, found[0]!.id)
  }
  return pairs
}

/** Copy the owner's edits from a pending row to its twin, never over a manual value. */
export function carryEdits(db: Db, from: Tx, toId: number): void {
  const to = db.select().from(transactions).where(eq(transactions.id, toId)).get()
  if (to === undefined) return
  const values: Partial<Tx> = {}
  if (from.note !== null && to.note === null) values.note = from.note
  if (from.one_time && !to.one_time) values.one_time = true
  if (Object.keys(values).length) db.update(transactions).set(values).where(eq(transactions.id, toId)).run()

  const cat = db.select().from(categorizations).where(eq(categorizations.transaction_id, from.id)).get()
  if (cat?.source !== 'manual') return
  const existing = db.select().from(categorizations).where(eq(categorizations.transaction_id, toId)).get()
  if (existing?.source === 'manual') return
  const row = {
    category_id: cat.category_id,
    essentiality: cat.essentiality,
    source: 'manual' as const,
    confidence: cat.confidence,
    updated_at: utcNow(),
  }
  if (existing === undefined) db.insert(categorizations).values({ transaction_id: toId, ...row }).run()
  else db.update(categorizations).set(row).where(eq(categorizations.transaction_id, toId)).run()
}

/** Drop pending rows, carrying edits to their unambiguous twins first. */
export function dropPending(db: Db, pending: readonly Tx[], candidates: readonly Tx[]): void {
  if (pending.length === 0) return
  const twins = findTwins(pending, candidates)
  for (const p of pending) {
    const twin = twins.get(p.id)
    if (twin !== undefined) carryEdits(db, p, twin)
  }
  db.delete(transactions)
    .where(inArray(transactions.id, pending.map((p) => p.id)))
    .run()
}

/**
 * Pending rows dated before `start` (outside this sync's window): drop the ones with an
 * unambiguous posted twin; leave the rest pending for the owner.
 */
export function dropBeyondReach(db: Db, start: PlainDate): void {
  const old = db
    .select()
    .from(transactions)
    .where(and(eq(transactions.pending, true), lt(transactions.posted_on, start)))
    .all()
  if (old.length === 0) return
  const accountIds = [...new Set(old.map((t) => t.account_id))]
  const posted = db
    .select()
    .from(transactions)
    .where(and(eq(transactions.pending, false), inArray(transactions.account_id, accountIds)))
    .all()
  const twins = findTwins(old, posted)
  dropPending(
    db,
    old.filter((t) => twins.has(t.id)),
    posted,
  )
}
