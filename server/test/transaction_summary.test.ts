/**
 * GET /api/transactions/summary: counts and sums for the whole filtered set, built from the
 * same filters as the list. Sums cover posted rows only; pending rows are counted apart.
 */

import { describe, expect, it } from 'vitest'
import type { Db } from '../src/db/index.js'
import { categorizations } from '../src/db/schema.js'
import { utcNow } from '../src/lib/dates.js'
import { cents, formatMoney, parseMoney } from '../src/lib/money.js'
import { categoryId, makeAccount, makeTx } from './factories.js'
import { makeApp } from './setup.js'

type App = ReturnType<typeof makeApp>['app']
type Row = { amount: string; pending: boolean }
type Summary = { count: number; pending_count: number; spent: string; received: string }
type Params = Record<string, string | number | boolean | (string | number)[]>

function query(params: Params): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value]) search.append(key, String(v))
  }
  return search.toString()
}

async function summary(app: App, params: Params = {}): Promise<Summary> {
  const r = await app.request(`/api/transactions/summary?${query(params)}`)
  expect(r.status).toBe(200)
  return (await r.json()) as Summary
}

/** Every row of the list for these filters, walking the pages. */
async function allRows(app: App, params: Params = {}, limit = 2): Promise<Row[]> {
  const rows: Row[] = []
  for (let offset = 0; ; offset += limit) {
    const r = await app.request(`/api/transactions?${query({ ...params, limit, offset })}`)
    const page = (await r.json()) as { items: Row[]; total: number }
    rows.push(...page.items)
    if (offset + limit >= page.total) return rows
  }
}

/** The summary the rows imply: posted money out and in, pending counted apart. */
function expected(rows: Row[]): Summary {
  let spent = 0
  let received = 0
  for (const row of rows) {
    if (row.pending) continue
    const amount = parseMoney(row.amount)
    if (amount < 0) spent -= amount
    else received += amount
  }
  return {
    count: rows.length,
    pending_count: rows.filter((r) => r.pending).length,
    spent: formatMoney(cents(spent)),
    received: formatMoney(cents(received)),
  }
}

function categorize(db: Db, txId: number, detailed: string, essentiality: 'essential' | 'discretionary' | null, confidence: 'high' | 'low' = 'high'): void {
  db.insert(categorizations)
    .values({ transaction_id: txId, category_id: categoryId(db, detailed), essentiality, source: 'llm', confidence, updated_at: utcNow() })
    .run()
}

function seed(db: Db) {
  const a = makeAccount(db)
  const b = makeAccount(db)
  const coffee = makeTx(db, a, '-4.00', 'BLUE BOTTLE COFFEE', '2026-01-05', { payee: 'Blue Bottle' })
  const grocery = makeTx(db, b, '-40.25', 'TRADER JOE S', '2026-02-05')
  const rent = makeTx(db, b, '-2000.00', 'ZELLE TO', '2026-03-05', { note: 'march rent' })
  const pay = makeTx(db, a, '3150.00', 'ACME PAYROLL', '2026-03-01')
  const refund = makeTx(db, a, '12.50', 'BLUE BOTTLE REFUND', '2026-03-02')
  makeTx(db, a, '-9.99', 'MYSTERY', '2026-03-03')
  makeTx(db, a, '-7.00', 'BLUE BOTTLE COFFEE', '2026-03-20', { pending: true })
  makeTx(db, a, '-500.00', 'TRANSFER TO SAVINGS', '2026-03-04', { is_transfer: true })
  makeTx(db, b, '500.00', 'TRANSFER FROM CHECKING', '2026-03-04', { is_transfer: true })
  categorize(db, coffee.id, 'FOOD_AND_DRINK_COFFEE', 'discretionary')
  categorize(db, grocery.id, 'FOOD_AND_DRINK_GROCERIES', 'essential')
  categorize(db, rent.id, 'RENT_AND_UTILITIES_RENT', 'essential', 'low')
  categorize(db, pay.id, 'INCOME_SALARY', null)
  categorize(db, refund.id, 'FOOD_AND_DRINK_COFFEE', 'discretionary')
  return { a, b, db }
}

describe('GET /api/transactions/summary', () => {
  it('matches the sum of the filtered rows across pages, transfers excluded by default', async () => {
    const { app, db } = makeApp()
    seed(db)
    const rows = await allRows(app)
    expect(rows).toHaveLength(7)
    expect(await summary(app)).toEqual(expected(rows))
    expect(await summary(app)).toEqual({ count: 7, pending_count: 1, spent: '2054.24', received: '3162.50' })
  })

  it('includes transfers when asked', async () => {
    const { app, db } = makeApp()
    seed(db)
    const s = await summary(app, { include_transfers: true })
    expect(s).toEqual(expected(await allRows(app, { include_transfers: true })))
    expect(s).toEqual({ count: 9, pending_count: 1, spent: '2554.24', received: '3662.50' })
  })

  it('respects every filter', async () => {
    const { app, db } = makeApp()
    const { a, b } = seed(db)
    const filters: Params[] = [
      { q: 'bottle' },
      { q: 'rent' },
      { start: '2026-03-01' },
      { end: '2026-02-28' },
      { start: '2026-02-01', end: '2026-03-02' },
      { account_id: a.id },
      { account_id: [a.id, b.id] },
      { category_id: categoryId(db, 'FOOD_AND_DRINK_COFFEE') },
      { category_id: [categoryId(db, 'FOOD_AND_DRINK_COFFEE'), categoryId(db, 'INCOME_SALARY')] },
      { essentiality: 'essential' },
      { essentiality: 'unset' },
      { uncategorized: true },
      { needs_review: true },
      { account_id: b.id, include_transfers: true },
    ]
    for (const params of filters) {
      expect(await summary(app, params), JSON.stringify(params)).toEqual(expected(await allRows(app, params, 3)))
    }
  })

  it('is all zero with no rows', async () => {
    const { app } = makeApp()
    expect(await summary(app)).toEqual({ count: 0, pending_count: 0, spent: '0.00', received: '0.00' })
  })
})
