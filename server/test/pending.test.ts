/**
 * Pending transactions count in no total: every report reads the same with or without them,
 * and the same rows count once they post (pending false). The Transactions list still
 * shows them.
 */

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/db/index.js'
import { type Essentiality, balanceSnapshots, categorizations, transactions } from '../src/db/schema.js'
import { utcNow } from '../src/lib/dates.js'
import { parseMoney } from '../src/lib/money.js'
import { getGoal } from '../src/services/goals.js'
import { buildContext } from '../src/services/suggestions.js'
import { type Account, type Transaction, categoryId, makeAccount, makeTx } from './factories.js'
import { makeApp } from './setup.js'

const TODAY = '2026-10-15'

let ctx: ReturnType<typeof makeApp>
let db: Db
let chk: Account

beforeEach(() => {
  vi.stubEnv('PLUTUS_TODAY', TODAY)
  ctx = makeApp()
  db = ctx.db
  chk = makeAccount(db, 'checking')
  db.insert(balanceSnapshots).values({ account_id: chk.id, balance: parseMoney('5000.00'), as_of: utcNow() }).run()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** Categorized with full confidence, so the review queue is the same either way. */
function categorize(txId: number, detailed: string, ess: Essentiality | null = null): void {
  db.insert(categorizations)
    .values({
      transaction_id: txId,
      category_id: categoryId(db, detailed),
      essentiality: ess,
      source: 'manual',
      confidence: 'very_high',
      updated_at: utcNow(),
    })
    .run()
}

function tx(amount: string, description: string, on: string, detailed: string, ess: Essentiality | null, pending = false) {
  const t = makeTx(db, chk, amount, description, on, { pending, merchant_key: description })
  categorize(t.id, detailed, ess)
  return t
}

/** Posted history: July through September complete, October in progress. */
function seedPosted(firstMonth = 7): void {
  for (let month = firstMonth; month <= 10; month++) {
    const mm = String(month).padStart(2, '0')
    tx('3000.00', 'PAYROLL', `2026-${mm}-01`, 'INCOME_SALARY', null)
    tx('-1000.00', 'RENT', `2026-${mm}-02`, 'RENT_AND_UTILITIES_RENT', 'essential')
    tx('-50.00', 'COFFEE', `2026-${mm}-03`, 'FOOD_AND_DRINK_COFFEE', 'discretionary')
  }
}

/** A pending expense and a pending income in September and in October. */
function addPending(): Transaction[] {
  return [
    tx('-200.00', 'DINNER', '2026-09-20', 'FOOD_AND_DRINK_RESTAURANT', 'discretionary', true),
    tx('500.00', 'BONUS', '2026-09-21', 'INCOME_SALARY', null, true),
    tx('-70.00', 'SHOP', '2026-10-10', 'FOOD_AND_DRINK_RESTAURANT', 'discretionary', true),
    tx('80.00', 'SIDE GIG', '2026-10-11', 'INCOME_SALARY', null, true),
  ]
}

function post(rows: readonly Transaction[]): void {
  for (const r of rows) db.update(transactions).set({ pending: false }).where(eq(transactions.id, r.id)).run()
}

async function get(path: string): Promise<any> {
  const r = await ctx.app.request(path)
  expect(r.status).toBe(200)
  return r.json()
}

async function makeGoal(): Promise<number> {
  const r = await ctx.app.request('/api/goals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Trip', target_amount: '6000', target_date: '2027-04-15' }),
  })
  expect(r.status).toBe(201)
  return ((await r.json()) as { id: number }).id
}

describe('pending transactions', () => {
  it('leave the monthly summary alone until they post', async () => {
    seedPosted()
    const before = await get('/api/reports/monthly?months=4')
    const rows = addPending()
    expect(await get('/api/reports/monthly?months=4')).toEqual(before)

    post(rows)
    const after = await get('/api/reports/monthly?months=4')
    expect(after[2]).toMatchObject({ month: '2026-09', income: '3500.00', expenses: '1250.00', discretionary: '250.00' })
    expect(after[3]).toMatchObject({ month: '2026-10', income: '3080.00', expenses: '1120.00', net: '1960.00' })
  })

  it('leave spending by category alone until they post', async () => {
    seedPosted()
    const before = await get('/api/reports/by-category?month=2026-10')
    const rows = addPending()
    expect(await get('/api/reports/by-category?month=2026-10')).toEqual(before)
    expect(await get('/api/reports/by-category?month=2026-10&essentiality=discretionary')).toEqual(
      before.filter((c: { label: string }) => c.label === 'Coffee'),
    )

    post(rows)
    const after = await get('/api/reports/by-category?month=2026-10')
    expect(after.map((c: { label: string; total: string; count: number }) => [c.label, c.total, c.count])).toEqual([
      ['Rent', '1000.00', 1],
      ['Restaurant', '70.00', 1],
      ['Coffee', '50.00', 1],
    ])
  })

  it('leave month detail tiles, lists, and counts alone until they post', async () => {
    seedPosted()
    const sept = await get('/api/reports/month/2026-09')
    const oct = await get('/api/reports/month/2026-10')
    const rows = addPending()
    expect(await get('/api/reports/month/2026-09')).toEqual(sept)
    expect(await get('/api/reports/month/2026-10')).toEqual(oct)
    expect(oct.transaction_count).toBe(3)

    post(rows)
    const d = await get('/api/reports/month/2026-09')
    expect([d.income, d.expenses, d.net]).toEqual(['3500.00', '1250.00', '2250.00'])
    expect(d.largest.map((t: { amount: string }) => t.amount)).toEqual(['-1000.00', '-200.00', '-50.00'])
    expect(d.income_transactions.map((t: { amount: string }) => t.amount)).toEqual(['3000.00', '500.00'])
    expect(d.transaction_count).toBe(5)
    expect(d.categories.map((c: { label: string }) => c.label)).toEqual(['Rent', 'Restaurant', 'Coffee'])
    // October's averages now include September's posted rows.
    expect((await get('/api/reports/month/2026-10')).expenses_average).toBe('1116.67')
  })

  it('stay in the Transactions list', async () => {
    seedPosted()
    addPending()
    const body = await get('/api/transactions?start=2026-10-01&end=2026-10-31')
    expect(body.items.filter((t: { pending: boolean }) => t.pending)).toHaveLength(2)
  })

  it('leave the projection alone until they post, history window included', async () => {
    seedPosted(10) // only October posted: a short history
    const before = await get('/api/projection')
    const old = tx('-90.00', 'OLD HOLD', '2026-08-01', 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE', null, true)
    const rows = addPending()
    expect(await get('/api/projection')).toEqual(before)

    post([old, ...rows])
    const after = await get('/api/projection')
    expect(after.months[0].variable_spending).not.toBe(before.months[0].variable_spending)
    expect(after.assumptions).not.toEqual(before.assumptions)
  })

  it('leave goal progress and the savings context alone until they post', async () => {
    seedPosted()
    const gid = await makeGoal()
    const progress = (await get(`/api/goals/${gid}`)).progress
    const context = buildContext(db, getGoal(db, gid))
    const rows = addPending()
    expect((await get(`/api/goals/${gid}`)).progress).toEqual(progress)
    expect(buildContext(db, getGoal(db, gid))).toEqual(context)

    post(rows)
    expect((await get(`/api/goals/${gid}`)).progress.actual_monthly_average).toBe('2050.00') // (1950 * 2 + 2250) / 3
    const restaurant = buildContext(db, getGoal(db, gid)).categories.find((c) => c.monthly_totals.includes(parseMoney('200.00')))
    expect(restaurant?.monthly_totals.at(-1)).toBe(parseMoney('200.00'))
  })

  it('leave What changed alone', async () => {
    seedPosted()
    const before = await get('/api/reports/changes')
    tx('-900.00', 'NEW STORE', '2026-10-12', 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE', 'discretionary', true)
    addPending()
    expect(await get('/api/reports/changes')).toEqual(before)
  })
})
