/**
 * Transaction queries and manual overrides (R2.1-R2.3).
 *
 * - `fields` holds the fields the client sent (defaults excluded); the route takes it from
 *   the request body's keys.
 * - Search lowers both sides; SQLite's lower() is ASCII-only, so `q` goes through pg_lower
 *   (categorize.ts).
 * - A column is written only when its value changes, so a row whose values are all unchanged
 *   keeps its updated_at (`changedValues`).
 * - An update is one transaction, so a DomainError part-way writes nothing.
 */

import { type SQL, and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { RuntimeDefaults } from '../config.js'
import type { Db } from '../db/index.js'
import {
  type Essentiality,
  type EssentialityFilter,
  type RuleMatchType,
  categories,
  categorizations,
  merchantClassifications,
  rules,
  transactions,
} from '../db/schema.js'
import { type PlainDate, utcNow } from '../lib/dates.js'
import { DomainError, NotFoundError } from '../lib/errors.js'
import { formatMoney } from '../lib/money.js'
import type { TransactionRead, TransactionUpdate } from '../schemas/transactions.js'
import type { SecretStore } from '../secrets.js'
import { essentialityCondition } from './aggregates.js'
import { pyStrip } from './categories.js'
import { applyRule, ensurePgLower, icontains } from './categorize.js'
import { runtimeConfig } from './config.js'
import { merchantKey as scrubMerchantKey } from './scrub.js'

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
    pending: tx.pending,
    merchant_key: tx.merchant_key,
    note: tx.note,
    one_time: tx.one_time,
    is_transfer: tx.is_transfer,
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

/** Filtered transactions, newest first, plus the total matching count. */
export function listTransactions(db: Db, filters: TransactionFilters): [TransactionRead[], number] {
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
    where.push(or(isNull(categorizations.transaction_id), inArray(categorizations.confidence, ['low', 'unknown'])) as SQL)
  }
  if (!filters.include_transfers) where.push(eq(transactions.is_transfer, false))
  const condition = and(...where)

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
    const onlyNoteOrOneTime = [...fields].every((f) => f === 'note' || f === 'one_time')
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
    saveRule(db, key, body.rule_match_type, categoryId, essentiality)
  }
}

function saveRule(
  db: Db,
  key: string,
  matchType: RuleMatchType,
  categoryId: number,
  essentiality: Essentiality | null,
): void {
  const existing = db
    .select()
    .from(rules)
    .where(and(eq(rules.match_type, matchType), eq(rules.pattern, key)))
    .get()
  let rule: typeof rules.$inferSelect
  if (existing === undefined) {
    rule = db
      .insert(rules)
      .values({ match_type: matchType, pattern: key, category_id: categoryId, essentiality })
      .returning()
      .get()
  } else {
    const changes = changedValues(existing, { category_id: categoryId, essentiality })
    rule = Object.keys(changes).length
      ? db.update(rules).set(changes).where(eq(rules.id, existing.id)).returning().get()
      : existing
  }

  const entryValues = {
    category_id: categoryId,
    essentiality,
    confidence: 'very_high' as const,
    source: 'manual' as const,
  }
  const entry = db.select().from(merchantClassifications).where(eq(merchantClassifications.merchant_key, key)).get()
  if (entry === undefined) {
    db.insert(merchantClassifications).values({ merchant_key: key, ...entryValues }).run()
  } else {
    const changes = changedValues(entry, entryValues)
    if (Object.keys(changes).length) {
      db.update(merchantClassifications).set(changes).where(eq(merchantClassifications.merchant_key, key)).run()
    }
  }

  applyRule(db, rule)
}
