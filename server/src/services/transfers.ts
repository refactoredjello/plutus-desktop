/**
 * Internal transfer matching (R2.4).
 *
 * Called by services/sync.ts after new transactions are stored. Keep the signature stable.
 */

import { and, asc, eq, isNull, ne } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { transactions } from '../db/schema.js'
import { daysBetween } from '../lib/dates.js'
import { ZERO } from '../lib/money.js'

/** WINDOW = timedelta(days=5): card payments often post a few business days apart. */
export const WINDOW_DAYS = 5

type Tx = typeof transactions.$inferSelect

/**
 * Pair unmatched transactions that are transfers between owned accounts.
 *
 * Two posted transactions pair when they sit in different accounts, have equal absolute
 * amounts with opposite signs, and are at most 5 days apart. When several candidates
 * exist the closest date wins, then the lowest ids, so results are deterministic.
 * Returns the number of transactions newly marked as transfers. The updates run in one
 * transaction, a savepoint when the caller already holds one.
 */
export function matchTransfers(db: Db): number {
  const unmatched = db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.is_transfer, false),
        isNull(transactions.transfer_pair_id),
        eq(transactions.pending, false),
        ne(transactions.amount, ZERO),
      ),
    )
    .orderBy(asc(transactions.id))
    .all()

  // Lists keyed by abs(amount); a Map keeps first-seen order, which decides pairing.
  const outflows = new Map<number, Tx[]>()
  const inflows = new Map<number, Tx[]>()
  for (const tx of unmatched) {
    const side = tx.amount < 0 ? outflows : inflows
    const size = Math.abs(tx.amount)
    const list = side.get(size)
    if (list === undefined) side.set(size, [tx])
    else list.push(tx)
  }

  const candidates: [number, number, number, Tx, Tx][] = []
  for (const [size, outs] of outflows) {
    for (const out of outs) {
      for (const inc of inflows.get(size) ?? []) {
        const gap = Math.abs(daysBetween(inc.posted_on, out.posted_on))
        if (out.account_id !== inc.account_id && gap <= WINDOW_DAYS) {
          candidates.push([gap, Math.min(out.id, inc.id), Math.max(out.id, inc.id), out, inc])
        }
      }
    }
  }
  // candidates.sort(key=lambda c: c[:3]); the key is unique per pair, so stability is moot.
  candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])

  const used = new Set<number>()
  const pairs: [Tx, Tx][] = []
  for (const [, , , out, inc] of candidates) {
    if (used.has(out.id) || used.has(inc.id)) continue
    used.add(out.id)
    used.add(inc.id)
    pairs.push([out, inc])
  }
  if (pairs.length) {
    db.transaction((t) => {
      for (const [out, inc] of pairs) {
        t.update(transactions).set({ is_transfer: true, transfer_pair_id: inc.id }).where(eq(transactions.id, out.id)).run()
        t.update(transactions).set({ is_transfer: true, transfer_pair_id: out.id }).where(eq(transactions.id, inc.id)).run()
      }
    })
  }
  return pairs.length * 2
}
