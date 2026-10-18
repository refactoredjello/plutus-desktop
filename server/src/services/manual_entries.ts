/**
 * Manual entries: expected income (positive) or expenses (negative) not yet in bank data (R5).
 */

import { asc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { type Recurrence, categories, manualEntries, transactions } from '../db/schema.js'
import type { PlainDate } from '../lib/dates.js'
import { DomainError, NotFoundError } from '../lib/errors.js'
import type { Cents } from '../lib/money.js'

export type ManualEntry = typeof manualEntries.$inferSelect

/** ManualEntryCreate after parsing, defaults filled. */
export interface ManualEntryCreate {
  amount: Cents
  description: string
  category_id?: number | null | undefined
  due_date: PlainDate | string
  recurrence: Recurrence
  end_date?: PlainDate | string | null | undefined
}

/**
 * `body.model_dump(exclude_unset=True)`: a key that is absent was not sent; a key that is null
 * was sent as null.
 */
export interface ManualEntryChanges {
  amount?: Cents | null
  description?: string | null
  category_id?: number | null
  due_date?: PlainDate | string | null
  recurrence?: Recurrence | null
  end_date?: PlainDate | string | null
  fulfilled_transaction_id?: number | null
}

interface Values {
  amount: Cents
  description: string
  category_id: number | null
  due_date: PlainDate
  recurrence: Recurrence
  end_date: PlainDate | null
  fulfilled_transaction_id: number | null
}

const REQUIRED = ['amount', 'description', 'due_date', 'recurrence'] as const

function validate(db: Db, values: Values): void {
  const endDate = values.end_date
  if (endDate !== null) {
    if (values.recurrence === 'none') {
      throw new DomainError('end_date must be empty when the entry does not recur')
    }
    if (endDate < values.due_date) throw new DomainError('end_date must not be before due_date')
  }
  const categoryId = values.category_id
  if (categoryId !== null) {
    const found = db.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId)).get()
    if (found === undefined) throw new DomainError(`Unknown category_id ${categoryId}`)
  }
  const txId = values.fulfilled_transaction_id
  if (txId !== null) {
    const found = db.select({ id: transactions.id }).from(transactions).where(eq(transactions.id, txId)).get()
    if (found === undefined) throw new DomainError(`Unknown fulfilled_transaction_id ${txId}`)
  }
}

export function listManualEntries(db: Db): ManualEntry[] {
  return db.select().from(manualEntries).orderBy(asc(manualEntries.due_date), asc(manualEntries.id)).all()
}

export function getManualEntry(db: Db, entryId: number): ManualEntry {
  const entry = db.select().from(manualEntries).where(eq(manualEntries.id, entryId)).get()
  if (entry === undefined) throw new NotFoundError(`Manual entry ${entryId} not found`)
  return entry
}

export function createManualEntry(db: Db, body: ManualEntryCreate): ManualEntry {
  const values: Values = {
    amount: body.amount,
    description: body.description,
    category_id: body.category_id ?? null,
    due_date: body.due_date as PlainDate,
    recurrence: body.recurrence,
    end_date: (body.end_date ?? null) as PlainDate | null,
    fulfilled_transaction_id: null,
  }
  validate(db, values)
  const { fulfilled_transaction_id: _unset, ...row } = values
  return db.insert(manualEntries).values(row).returning().get()
}

export function updateManualEntry(db: Db, entryId: number, changes: ManualEntryChanges): ManualEntry {
  const entry = getManualEntry(db, entryId)
  for (const name of REQUIRED) {
    if (name in changes && changes[name] === null) throw new DomainError(`${name} cannot be null`)
  }
  const merged = {
    amount: entry.amount,
    description: entry.description,
    category_id: entry.category_id,
    due_date: entry.due_date,
    recurrence: entry.recurrence,
    end_date: entry.end_date,
    fulfilled_transaction_id: entry.fulfilled_transaction_id,
    ...changes,
  } as Values
  validate(db, merged)
  const patch = changes as Partial<typeof manualEntries.$inferInsert>
  if (Object.keys(patch).length === 0) return entry
  return db.update(manualEntries).set(patch).where(eq(manualEntries.id, entryId)).returning().get()
}

export function deleteManualEntry(db: Db, entryId: number): void {
  getManualEntry(db, entryId)
  db.delete(manualEntries).where(eq(manualEntries.id, entryId)).run()
}
