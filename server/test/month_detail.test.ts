/**
 * The month detail report, plus the float ratios (`share`, `savings_rate`): the exact
 * quotient as a double, rounded to 4 decimals half to even on the double's exact value.
 * JavaScript's toFixed and Math.round round those ties up, so the cases below are chosen
 * where the two disagree (0.03125 is 0.0312 here, 0.0313 with toFixed).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/db/index.js'
import { type Essentiality, categorizations } from '../src/db/schema.js'
import { utcNow } from '../src/lib/dates.js'
import { cents } from '../src/lib/money.js'
import { roundedRatio } from '../src/services/reports.js'
import { categoryId, makeAccount, makeTx } from './factories.js'
import { makeApp } from './setup.js'

// fixed_today
beforeEach(() => {
  vi.stubEnv('PLUTUS_TODAY', '2026-10-04')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** Categorize a transaction directly, as the aggregates tests do. */
function categorize(db: Db, txId: number, detailed: string, ess: Essentiality | null = null): void {
  db.insert(categorizations)
    .values({
      transaction_id: txId,
      category_id: categoryId(db, detailed),
      essentiality: ess,
      source: 'manual',
      updated_at: utcNow(),
    })
    .run()
}

function seed(db: Db): void {
  const chk = makeAccount(db, 'checking')
  // June is empty: averages must skip it rather than dilute.
  for (const [month, pay, rent, coffee] of [
    [5, '3000.00', '-1000.00', '-50.00'],
    [7, '3000.00', '-1000.00', '-80.00'],
    [8, '3600.00', '-1000.00', '-110.00'],
  ] as const) {
    const mm = String(month).padStart(2, '0')
    const p = makeTx(db, chk, pay, 'PAY', `2026-${mm}-01`)
    categorize(db, p.id, 'INCOME_SALARY')
    const r = makeTx(db, chk, rent, 'RENT', `2026-${mm}-02`)
    categorize(db, r.id, 'RENT_AND_UTILITIES_RENT', 'essential')
    const c = makeTx(db, chk, coffee, 'COFFEE', `2026-${mm}-03`)
    categorize(db, c.id, 'FOOD_AND_DRINK_COFFEE', 'discretionary')
  }
  // September: the month under test.
  const p = makeTx(db, chk, '3000.00', 'PAY', '2026-09-01')
  categorize(db, p.id, 'INCOME_SALARY')
  const r = makeTx(db, chk, '-1000.00', 'RENT', '2026-09-02')
  categorize(db, r.id, 'RENT_AND_UTILITIES_RENT', 'essential')
  for (const [day, amount] of [
    ['05', '-40.00'],
    ['06', '-60.00'],
  ] as const) {
    const c = makeTx(db, chk, amount, 'COFFEE', `2026-09-${day}`)
    categorize(db, c.id, 'FOOD_AND_DRINK_COFFEE', 'discretionary')
  }
  // Categorized rows are confident; only the uncategorized one below needs review.
  db.update(categorizations).set({ confidence: 'very_high' }).run()
  makeTx(db, chk, '-25.00', 'MYSTERY', '2026-09-09')
  makeTx(db, chk, '-500.00', 'TO SAVINGS', '2026-09-10', { is_transfer: true })
}

async function detail(app: ReturnType<typeof makeApp>['app'], month: string): Promise<any> {
  const r = await app.request(`/api/reports/month/${month}`)
  expect(r.status).toBe(200)
  return r.json()
}

it('month detail totals averages and breakdown', async () => {
  const { app, db } = makeApp()
  seed(db)
  const d = await detail(app, '2026-09')
  expect(d.is_complete).toBe(true)
  expect([d.days_elapsed, d.days_in_month]).toEqual([30, 30])
  expect(d.average_months).toBe(3) // May, July, August; empty June skipped
  expect(d.income).toBe('3000.00')
  expect(d.income_average).toBe('3200.00')
  expect(d.expenses).toBe('1125.00')
  expect(d.expenses_average).toBe('1080.00') // (1050 + 1080 + 1110) / 3
  expect(d.net).toBe('1875.00')
  expect(d.savings_rate).toBe(0.625)
  const shares = Object.fromEntries(
    d.essentiality.map((e: { essentiality: string; total: string; share: number }) => [e.essentiality, [e.total, e.share]]),
  )
  expect(shares.essential).toEqual(['1000.00', 0.8889])
  expect(shares.discretionary).toEqual(['100.00', 0.0889])
  expect(shares.unset).toEqual(['25.00', 0.0222])
  const cats = Object.fromEntries(d.categories.map((c: { label: string }) => [c.label, c]))
  expect(d.categories.map((c: { label: string }) => c.label)).toEqual(['Rent', 'Coffee', 'Uncategorized'])
  expect(cats.Coffee.total).toBe('100.00')
  expect(cats.Coffee.count).toBe(2)
  expect(cats.Coffee.average).toBe('80.00')
  expect(cats.Uncategorized.average).toBe('0.00')
  expect(d.largest.map((t: { amount: string }) => t.amount)).toEqual(['-1000.00', '-60.00', '-40.00', '-25.00'])
  expect(d.transaction_count).toBe(5) // transfer excluded
  expect(d.review_count).toBe(1)
})

it('current month is in progress', async () => {
  const { app, db } = makeApp()
  seed(db)
  const d = await detail(app, '2026-10')
  expect(d.is_complete).toBe(false)
  expect([d.days_elapsed, d.days_in_month]).toEqual([4, 31])
  expect(d.expenses).toBe('0.00')
  expect(d.average_months).toBe(3)
})

it('no history means no averages', async () => {
  const { app } = makeApp()
  const d = await detail(app, '2026-09')
  expect(d.average_months).toBe(0)
  expect(d.income_average).toBeNull()
  expect(d.savings_rate).toBeNull()
})

it('future and invalid months rejected', async () => {
  const { app } = makeApp()
  expect((await app.request('/api/reports/month/2026-11')).status).toBe(400)
  expect((await app.request('/api/reports/month/2026-13')).status).toBe(400)
  expect((await app.request('/api/reports/month/sept')).status).toBe(422)
})

describe('month detail details', () => {
  it('serializes the largest expenses as TransactionRead, categorization included', async () => {
    const { app, db } = makeApp()
    seed(db)
    const d = await detail(app, '2026-09')
    const [rent, , , mystery] = d.largest
    expect(rent).toMatchObject({
      posted_on: '2026-09-02',
      amount: '-1000.00',
      raw_description: 'RENT',
      payee: null,
      pending: false,
      merchant_key: null,
      note: null,
      one_time: false,
      is_transfer: false,
      categorization: {
        category_id: categoryId(db, 'RENT_AND_UTILITIES_RENT'),
        essentiality: 'essential',
        source: 'manual',
        confidence: 'very_high',
      },
    })
    expect(Object.keys(rent).sort()).toEqual(
      [
        'id',
        'account_id',
        'posted_on',
        'amount',
        'raw_description',
        'payee',
        'memo',
        'pending',
        'merchant_key',
        'note',
        'one_time',
        'is_transfer',
        'categorization',
      ].sort(),
    )
    expect(mystery.categorization).toBeNull()
  })

  it('lists income transactions that sum to the income total, refunds and transfers excluded', async () => {
    const { app, db } = makeApp()
    seed(db)
    const chk = makeAccount(db, 'checking')
    makeTx(db, chk, '120.00', 'MOBILE DEPOSIT', '2026-09-12') // uncategorized: counts as income
    const refund = makeTx(db, chk, '15.00', 'COFFEE REFUND', '2026-09-13')
    categorize(db, refund.id, 'FOOD_AND_DRINK_COFFEE') // a refund reduces spending instead
    const moved = makeTx(db, chk, '400.00', 'FROM SAVINGS', '2026-09-14')
    categorize(db, moved.id, 'TRANSFER_IN_SAVINGS') // money movement
    makeTx(db, chk, '700.00', 'OWN ACCOUNT', '2026-09-15', { is_transfer: true })
    makeTx(db, chk, '99.00', 'OCTOBER PAY', '2026-10-01')
    const d = await detail(app, '2026-09')
    expect(d.income).toBe('3120.00')
    const amounts = d.income_transactions.map((t: { amount: string }) => t.amount)
    expect(amounts).toEqual(['3000.00', '120.00'])
    const total = amounts.reduce((s: number, a: string) => s + Math.round(Number(a) * 100), 0)
    expect((total / 100).toFixed(2)).toBe(d.income)
    expect(d.income_transactions[1]).toMatchObject({ raw_description: 'MOBILE DEPOSIT', categorization: null })
  })

  it('rounds shares half to even on the float', async () => {
    const { app, db } = makeApp()
    const chk = makeAccount(db)
    const pay = makeTx(db, chk, '64.00', 'PAY', '2026-09-01')
    categorize(db, pay.id, 'INCOME_SALARY')
    const spend: [string, Essentiality | null][] = [
      ['-1.00', 'essential'], // 1/32 = 0.03125 -> 0.0312
      ['-3.00', 'discretionary'], // 3/32 = 0.09375 -> 0.0938
      ['-5.00', 'flexible'], // 5/32 = 0.15625 -> 0.1562
      ['-23.00', null], // 23/32 = 0.71875 -> 0.7188
    ]
    for (const [amount, ess] of spend) {
      const tx = makeTx(db, chk, amount, 'SHOP', '2026-09-02')
      categorize(db, tx.id, 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE', ess)
    }
    const d = await detail(app, '2026-09')
    expect(d.expenses).toBe('32.00')
    expect(d.essentiality).toEqual([
      { essentiality: 'essential', total: '1.00', share: 0.0312 },
      { essentiality: 'flexible', total: '5.00', share: 0.1562 },
      { essentiality: 'discretionary', total: '3.00', share: 0.0938 },
      { essentiality: 'unset', total: '23.00', share: 0.7188 },
    ])
    expect(d.savings_rate).toBe(0.5)
  })

  it('rounds savings rates half to even, and the average rate from the averages', async () => {
    const { app, db } = makeApp()
    const chk = makeAccount(db)
    for (const [month, pay, spend] of [
      ['07', '32.00', '-27.00'],
      ['08', '32.00', '-27.00'],
      ['09', '32.00', '-31.00'],
    ] as const) {
      const p = makeTx(db, chk, pay, 'PAY', `2026-${month}-01`)
      categorize(db, p.id, 'INCOME_SALARY')
      makeTx(db, chk, spend, 'SHOP', `2026-${month}-02`)
    }
    const d = await detail(app, '2026-09')
    expect(d.savings_rate).toBe(0.0312) // 1/32
    expect(d.average_months).toBe(2)
    expect(d.net_average).toBe('5.00')
    expect(d.savings_rate_average).toBe(0.1562) // 5/32
  })

  it('a month with no expenses has zero shares; no income means no savings rate', async () => {
    const { app, db } = makeApp()
    const chk = makeAccount(db)
    makeTx(db, chk, '-10.00', 'SHOP', '2026-08-02')
    const d = await detail(app, '2026-09')
    expect(d.essentiality.map((e: { share: number }) => e.share)).toEqual([0, 0, 0, 0])
    expect(d.savings_rate).toBeNull()
    expect(d.average_months).toBe(1)
    expect(d.income_average).toBe('0.00')
    expect(d.savings_rate_average).toBeNull()
  })

  it('roundedRatio: 28-digit quotient, then double, then 4 decimals', () => {
    const r = (a: number, b: number) => roundedRatio(cents(a), cents(b))
    expect(r(100, 3200)).toBe(0.0312)
    expect(r(-100, 3200)).toBe(-0.0312)
    expect(r(300, 3200)).toBe(0.0938)
    expect(r(100, 300)).toBe(0.3333)
    expect(r(200, 300)).toBe(0.6667)
    expect(r(187500, 300000)).toBe(0.625)
    expect(r(100000, 112500)).toBe(0.8889)
    expect(r(-2000, 1000)).toBe(-2)
    expect(r(123456789, 7)).toBe(17636684.1429)
  })
})
