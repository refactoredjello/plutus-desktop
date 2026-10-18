/**
 * Internal transfer matching (R2.4) and unpairing (backlog 36).
 *
 * Called by services/sync.ts after new transactions are stored, with the ids of the new and
 * newly posted rows: a pair needs one of them, so older rows the owner unpaired stay unpaired.
 */

import { and, asc, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { type AccountType, accounts, categories, categorizations, transactions } from '../db/schema.js'
import { daysBetween } from '../lib/dates.js'
import { DomainError, NotFoundError } from '../lib/errors.js'
import { ZERO } from '../lib/money.js'
import type { TransactionRead } from '../schemas/transactions.js'
import { toTransactionRead } from './transactions.js'

/** At most 5 days apart: card payments often post a few business days apart. */
export const WINDOW_DAYS = 5

type Tx = typeof transactions.$inferSelect

/** Transfer and payment words, matched as whole words in the description or payee. */
const TRANSFER_WORDS = /\b(?:TRANSFER|XFER|PAYMENT|PYMT|AUTOPAY|ONLINE\s+PMT|THANK\s+YOU|ACH|ZELLE)\b/i

const DEPOSITORY: ReadonlySet<AccountType> = new Set(['checking', 'savings'])
const CREDIT_OR_LOAN: ReadonlySet<AccountType> = new Set(['credit', 'loan'])

/** What categorize.ts assignTransfer writes on a pair; unpairing removes it. */
const TRANSFER_CATEGORIES = [
  'TRANSFER_IN_SAVINGS',
  'TRANSFER_IN_ACCOUNT_TRANSFER',
  'TRANSFER_OUT_SAVINGS',
  'TRANSFER_OUT_ACCOUNT_TRANSFER',
]

const hasTransferWord = (tx: Tx): boolean => TRANSFER_WORDS.test(tx.raw_description) || TRANSFER_WORDS.test(tx.payee ?? '')

/**
 * A reason to believe two amount-matched rows are one transfer: a transfer or payment word on
 * either side, a checking or savings account against a credit or loan account, or two checking
 * or savings accounts. Two cards (or unknown types) need the word.
 */
function hasSignal(a: Tx, b: Tx, types: ReadonlyMap<number, AccountType>): boolean {
  if (hasTransferWord(a) || hasTransferWord(b)) return true
  const ta = types.get(a.account_id) ?? 'other'
  const tb = types.get(b.account_id) ?? 'other'
  if (DEPOSITORY.has(ta)) return DEPOSITORY.has(tb) || CREDIT_OR_LOAN.has(tb)
  return CREDIT_OR_LOAN.has(ta) && DEPOSITORY.has(tb)
}

/**
 * Pair unmatched transactions that are transfers between owned accounts.
 *
 * Two posted transactions pair when they sit in different accounts, have equal absolute
 * amounts with opposite signs, are at most 5 days apart, and show a transfer signal
 * (`hasSignal`). With `only`, a pair also needs one of its rows in it. When several
 * candidates exist the closest date wins, then the lowest ids, so results are deterministic.
 * Returns the number of transactions newly marked as transfers. The updates run in one
 * transaction, a savepoint when the caller already holds one.
 */
export function matchTransfers(db: Db, only?: ReadonlySet<number>): number {
  if (only?.size === 0) return 0

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

  const types = new Map(
    db
      .select({ id: accounts.id, type: accounts.type })
      .from(accounts)
      .all()
      .map((a) => [a.id, a.type]),
  )

  const candidates: [number, number, number, Tx, Tx][] = []
  for (const [size, outs] of outflows) {
    for (const out of outs) {
      for (const inc of inflows.get(size) ?? []) {
        const gap = Math.abs(daysBetween(inc.posted_on, out.posted_on))
        if (
          out.account_id !== inc.account_id &&
          gap <= WINDOW_DAYS &&
          (only === undefined || only.has(out.id) || only.has(inc.id)) &&
          hasSignal(out, inc, types)
        ) {
          candidates.push([gap, Math.min(out.id, inc.id), Math.max(out.id, inc.id), out, inc])
        }
      }
    }
  }
  // By gap, then the lower id, then the higher; the key is unique per pair, so stability is moot.
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

/**
 * Undo a pairing: clear is_transfer and transfer_pair_id on the transaction and its pair, and
 * drop the transfer category the pairing gave them (manual and other categories stay), so the
 * next sync categorizes them like any other row. A transfer whose pair is gone unpairs alone.
 */
export function unpairTransfer(db: Db, transactionId: number): TransactionRead {
  return db.transaction(() => {
    const tx = db.select().from(transactions).where(eq(transactions.id, transactionId)).get()
    if (tx === undefined) throw new NotFoundError(`Transaction ${transactionId} not found`)
    if (!tx.is_transfer && tx.transfer_pair_id === null) {
      throw new DomainError(`Transaction ${transactionId} is not a transfer`)
    }
    const ids = tx.transfer_pair_id === null ? [tx.id] : [tx.id, tx.transfer_pair_id]
    db.update(transactions)
      .set({ is_transfer: false, transfer_pair_id: null })
      .where(or(inArray(transactions.id, ids), inArray(transactions.transfer_pair_id, ids)))
      .run()
    const transferCategoryIds = db
      .select({ id: categories.id })
      .from(categories)
      .where(inArray(categories.detailed, TRANSFER_CATEGORIES))
      .all()
      .map((c) => c.id)
    db.delete(categorizations)
      .where(
        and(
          inArray(categorizations.transaction_id, ids),
          eq(categorizations.source, 'rule'),
          eq(categorizations.confidence, 'high'),
          inArray(categorizations.category_id, transferCategoryIds),
        ),
      )
      .run()
    const saved = db.select().from(transactions).where(eq(transactions.id, transactionId)).get() as Tx
    const cat = db.select().from(categorizations).where(eq(categorizations.transaction_id, transactionId)).get()
    return toTransactionRead(saved, cat)
  })
}
