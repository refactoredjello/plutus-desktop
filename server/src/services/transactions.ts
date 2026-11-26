/**
 * Transaction queries and manual overrides.
 *
 * - `fields` holds the fields the client sent; the route takes it from the request body's keys.
 *   The rule options (save_as_rule, rule_match_type, rule_pattern) count only when save_as_rule
 *   is true, so sending their defaults with a note-only edit is still a note-only edit.
 * - Search lowers both sides; SQLite's lower() is ASCII-only, so `q` goes through simple_lower
 *   (categorize.ts).
 * - A column is written only when its value changes, so a row whose values are all unchanged
 *   keeps its updated_at (`changedValues`).
 * - An update is one transaction, so a DomainError part-way writes nothing.
 */

import { type SQL, and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { RuntimeDefaults } from '../config.js'
import type { Db } from '../db/index.js'
import { type Essentiality, type EssentialityFilter, categories, categorizations, transactions } from '../db/schema.js'
import { type PlainDate, utcNow } from '../lib/dates.js'
import { ConflictError, DomainError, NotFoundError } from '../lib/errors.js'
import { cents, formatMoney } from '../lib/money.js'
import type { TransactionRead, TransactionRuleRead, TransactionSummary, TransactionUpdate } from '../schemas/transactions.js'
import type { SecretStore } from '../secrets.js'
import { essentialityCondition } from './aggregates.js'
import { pyStrip, saveRule } from './categories.js'
import { containsPattern, ensurePgLower, icontains, matchingRule } from './categorize.js'
import { runtimeConfig } from './config.js'
import { reviewReason, stalePendingCondition } from './pending.js'
import { detectRecurring } from './recurring.js'
import { merchantKey as scrubMerchantKey } from './scrub.js'
import { matchTransfers } from './transfers.js'

type Tx = typeof transactions.$inferSelect
type Categorization = typeof categorizations.$inferSelect

/** A transaction as TransactionRead, with its categorization row if any. */
export function toTransactionRead(tx: Tx, cat: Categorization | null | undefined): TransactionRead {
  return {
    id: tx.id,
    account_id: tx.account_id,
    posted_on: tx.posted_on,
    amount: formatMoney(tx.amount),
    raw_description: tx.raw_description,
    payee: tx.payee,
    memo: tx.memo,
    pending: tx.pending,
    merchant_key: tx.merchant_key,
    note: tx.note,
    one_time: tx.one_time,
    is_transfer: tx.is_transfer,
    review_reason: reviewReason(tx),
    categorization: cat
      ? { category_id: cat.category_id, essentiality: cat.essentiality, source: cat.source, confidence: cat.confidence }
      : null,
  }
}

/** listTransactions' filters and paging. */
export interface TransactionFilters {
  q: string | null
  start: PlainDate | null
  end: PlainDate | null
  account_ids: readonly number[] | null
  category_ids: readonly number[] | null
  essentiality: EssentialityFilter | null
  uncategorized: boolean
  needs_review: boolean
  include_transfers: boolean
  limit: number
  offset: number
}

/** The WHERE for the list's filters, over transactions left-joined to categorizations. */
function filterCondition(db: Db, filters: Omit<TransactionFilters, 'limit' | 'offset'>): SQL | undefined {
  const { q, start, end, account_ids, category_ids, essentiality } = filters
  const where: SQL[] = []
  if (q) {
    ensurePgLower(db)
    where.push(
      or(icontains(transactions.raw_description, q), icontains(transactions.payee, q), icontains(transactions.note, q)) as SQL,
    )
  }
  if (start) where.push(sql`${transactions.posted_on} >= ${start}`)
  if (end) where.push(sql`${transactions.posted_on} <= ${end}`)
  if (account_ids?.length) where.push(inArray(transactions.account_id, [...account_ids]))
  if (category_ids?.length) where.push(inArray(categorizations.category_id, [...category_ids]))
  if (essentiality) where.push(essentialityCondition(essentiality))
  if (filters.uncategorized) where.push(isNull(categorizations.transaction_id))
  if (filters.needs_review) {
    where.push(
      or(
        isNull(categorizations.transaction_id),
        inArray(categorizations.confidence, ['low', 'unknown']),
        stalePendingCondition(),
      ) as SQL,
    )
  }
  if (!filters.include_transfers) where.push(eq(transactions.is_transfer, false))
  return and(...where)
}

/** Filtered transactions, newest first, plus the total matching count. */
export function listTransactions(db: Db, filters: TransactionFilters): [TransactionRead[], number] {
  const condition = filterCondition(db, filters)

  // One categorization per transaction (its primary key), so the join never adds rows.
  const total =
    db
      .select({ n: count() })
      .from(transactions)
      .leftJoin(categorizations, eq(categorizations.transaction_id, transactions.id))
      .where(condition)
      .get()?.n ?? 0
  const rows = db
    .select({ tx: transactions, cat: categorizations })
    .from(transactions)
    .leftJoin(categorizations, eq(categorizations.transaction_id, transactions.id))
    .where(condition)
    .orderBy(desc(transactions.posted_on), desc(transactions.id))
    .limit(filters.limit)
    .offset(filters.offset)
    .all()
  return [rows.map((r) => toTransactionRead(r.tx, r.cat)), total]
}

/**
 * Count and sums for every row the filters match. Pending rows count but stay out of both sums,
 * as in every total (aggregates.ts); transfers follow include_transfers like the list. The sums
 * split posted rows by sign, so they add up to the rows the list shows; income and expense
 * rules (refunds, money movement) belong to the month reports.
 */
export function summarizeTransactions(db: Db, filters: Omit<TransactionFilters, 'limit' | 'offset'>): TransactionSummary {
  const posted = sql`${transactions.pending} = 0`
  const row = db
    .select({
      count: count(),
      pending: sql<number>`coalesce(sum(case when ${transactions.pending} = 1 then 1 else 0 end), 0)`,
      spent: sql<number>`coalesce(sum(case when ${posted} and ${transactions.amount} < 0 then -${transactions.amount} else 0 end), 0)`,
      received: sql<number>`coalesce(sum(case when ${posted} and ${transactions.amount} > 0 then ${transactions.amount} else 0 end), 0)`,
    })
    .from(transactions)
    .leftJoin(categorizations, eq(categorizations.transaction_id, transactions.id))
    .where(filterCondition(db, filters))
    .get()
  return {
    count: row?.count ?? 0,
    pending_count: row?.pending ?? 0,
    spent: formatMoney(cents(row?.spent ?? 0)),
    received: formatMoney(cents(row?.received ?? 0)),
  }
}

/** The values that differ from the row: what an update writes. */
function changedValues<T extends object>(row: T, values: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([k, v]) => row[k as keyof T] !== v)) as Partial<T>
}

function getTransaction(db: Db, transactionId: number): Tx | undefined {
  return db.select().from(transactions).where(eq(transactions.id, transactionId)).get()
}

function getCategorization(db: Db, transactionId: number): Categorization | undefined {
  return db.select().from(categorizations).where(eq(categorizations.transaction_id, transactionId)).get()
}

/** Context the override needs: the owner name tokens, read when needed. */
interface OwnerSettings {
  secrets: SecretStore
  defaults: RuntimeDefaults
}

/** Fields that only shape the rule save_as_rule creates. */
const RULE_OPTIONS: ReadonlySet<string> = new Set(['save_as_rule', 'rule_match_type', 'rule_pattern'])

/**
 * Manual override of category and/or essentiality; optionally saved as a rule.
 * `fields` holds the body keys the client sent.
 */
export function updateTransaction(
  db: Db,
  secrets: SecretStore,
  defaults: RuntimeDefaults,
  transactionId: number,
  body: TransactionUpdate,
  fields: ReadonlySet<string>,
): TransactionRead {
  return db.transaction(() => {
    const tx = getTransaction(db, transactionId)
    if (tx === undefined) throw new NotFoundError(`Transaction ${transactionId} not found`)

    const values: Partial<Tx> = {}
    if (fields.has('note')) values.note = pyStrip(body.note || '') || null
    if (body.one_time != null) values.one_time = body.one_time
    const changes = changedValues(tx, values)
    if (Object.keys(changes).length) db.update(transactions).set(changes).where(eq(transactions.id, tx.id)).run()

    const categoryChanges = body.category_id != null || fields.has('essentiality') || body.save_as_rule
    // A note- or one-time-only edit leaves the categorization alone.
    const counted = [...fields].filter((f) => body.save_as_rule || !RULE_OPTIONS.has(f))
    const onlyNoteOrOneTime = counted.every((f) => f === 'note' || f === 'one_time')
    if (categoryChanges || !onlyNoteOrOneTime) {
      overrideCategory(db, { secrets, defaults }, { ...tx, ...values }, body, fields)
    }

    const saved = getTransaction(db, transactionId) as Tx
    return toTransactionRead(saved, getCategorization(db, transactionId))
  })
}

function overrideCategory(
  db: Db,
  settings: OwnerSettings,
  tx: Tx,
  body: TransactionUpdate,
  fields: ReadonlySet<string>,
): void {
  const current = getCategorization(db, tx.id)
  let categoryId: number
  if (body.category_id != null) {
    if (db.select({ id: categories.id }).from(categories).where(eq(categories.id, body.category_id)).get() === undefined) {
      throw new DomainError(`Unknown category ${body.category_id}`)
    }
    categoryId = body.category_id
  } else if (current !== undefined) {
    categoryId = current.category_id
  } else {
    throw new DomainError('category_id is required for a transaction without a category')
  }

  const essentiality: Essentiality | null = fields.has('essentiality')
    ? (body.essentiality ?? null)
    : (current?.essentiality ?? null)

  const values = {
    category_id: categoryId,
    essentiality,
    source: 'manual' as const,
    confidence: 'very_high' as const,
    updated_at: utcNow(),
  }
  if (current === undefined) db.insert(categorizations).values({ transaction_id: tx.id, ...values }).run()
  else db.update(categorizations).set(values).where(eq(categorizations.transaction_id, tx.id)).run()

  if (body.save_as_rule) {
    const key =
      tx.merchant_key ||
      scrubMerchantKey(tx.raw_description, runtimeConfig(db, settings.secrets, settings.defaults).ownerNameTokens)
    if (tx.merchant_key !== key) db.update(transactions).set({ merchant_key: key }).where(eq(transactions.id, tx.id)).run()
    const matchType = body.rule_match_type
    const pattern = body.rule_pattern ?? (matchType === 'contains' ? defaultContainsPattern(tx) : key)
    saveRule(db, { match_type: matchType, pattern, category_id: categoryId, essentiality })
  }
}

/**
 * GET /api/transactions/{id}/rule: the rule categorization picks for this transaction, with its
 * precedence, or null (always for a transfer, which rules never categorize); and defaults for
 * a new rule, as save_as_rule builds them. A transaction without a merchant key yet is matched
 * on the key the next sync would give it. Read-only.
 */
export function transactionRule(
  db: Db,
  secrets: SecretStore,
  defaults: RuntimeDefaults,
  transactionId: number,
): TransactionRuleRead {
  const tx = getTransaction(db, transactionId)
  if (tx === undefined) throw new NotFoundError(`Transaction ${transactionId} not found`)
  const key = tx.merchant_key || scrubMerchantKey(tx.raw_description, runtimeConfig(db, secrets, defaults).ownerNameTokens)
  const rule = tx.is_transfer ? undefined : matchingRule(db, key, tx.raw_description)
  const current = getCategorization(db, tx.id)
  return {
    rule: rule ?? null,
    suggestion: {
      match_type: 'exact',
      pattern: key,
      contains_pattern: defaultContainsPattern(tx),
      category_id: current?.category_id ?? null,
      essentiality: current?.essentiality ?? null,
    },
  }
}

/**
 * A contains rule matches the raw description, so it defaults to the payee only when the
 * description contains it, else to the description. Either way it matches its own transaction.
 */
function defaultContainsPattern(tx: Tx): string {
  const payee = pyStrip(tx.payee ?? '')
  return payee && containsPattern(tx.raw_description, payee) ? payee : tx.raw_description
}

function pendingTransaction(db: Db, transactionId: number): Tx {
  const tx = getTransaction(db, transactionId)
  if (tx === undefined) throw new NotFoundError(`Transaction ${transactionId} not found`)
  if (!tx.pending) throw new ConflictError(`Transaction ${transactionId} is not pending.`)
  return tx
}

/**
 * POST /api/transactions/{id}/mark-posted: the owner says a pending row is a real charge, so it
 * counts in totals. Transfer pairing and recurring detection pick it up as a new posting. It
 * stays posted until the bank itself returns its external id as pending again.
 */
export function markPosted(db: Db, transactionId: number): TransactionRead {
  return db.transaction(() => {
    const tx = pendingTransaction(db, transactionId)
    db.update(transactions).set({ pending: false }).where(eq(transactions.id, tx.id)).run()
    matchTransfers(db, new Set([tx.id]))
    detectRecurring(db)
    return toTransactionRead(getTransaction(db, tx.id) as Tx, getCategorization(db, tx.id))
  })
}

/** DELETE /api/transactions/{id}: remove a pending hold that never became a charge. */
export function removePending(db: Db, transactionId: number): void {
  db.transaction(() => {
    const tx = pendingTransaction(db, transactionId)
    db.delete(transactions).where(eq(transactions.id, tx.id)).run()
  })
}
