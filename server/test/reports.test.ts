/** Ports api/tests/test_reports.py. */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Db } from '../src/db/index.js'
import { type Essentiality, balanceSnapshots, categorizations } from '../src/db/schema.js'
import { utcNow } from '../src/lib/dates.js'
import { parseMoney } from '../src/lib/money.js'
import { categoryId, makeAccount, makeTx } from './factories.js'
import { makeApp } from './setup.js'

const TODAY = '2026-03-15'

// fixed_today: schedule.today() is pinned through PLUTUS_TODAY.
beforeEach(() => {
  vi.stubEnv('PLUTUS_TODAY', TODAY)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** tests.test_aggregates.categorize. */
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

function snapshot(db: Db, accountId: number, balance: string, day: string): void {
  db.insert(balanceSnapshots)
    .values({ account_id: accountId, balance: parseMoney(balance), as_of: `${day}T12:00:00.000Z` })
    .run()
}

async function getJson(app: ReturnType<typeof makeApp>['app'], path: string): Promise<any> {
  const r = await app.request(path)
  expect(r.status).toBe(200)
  return r.json()
}

it('test_monthly_maps_totals_and_net', async () => {
  const { app, db } = makeApp()
  const chk = makeAccount(db)
  const salary = makeTx(db, chk, '3000.00', 'PAYROLL', '2026-03-01')
  categorize(db, salary.id, 'INCOME_SALARY')
  const rent = makeTx(db, chk, '-2000.00', 'RENT', '2026-03-02')
  categorize(db, rent.id, 'RENT_AND_UTILITIES_RENT', 'essential')

  const body = await getJson(app, '/api/reports/monthly?months=2')
  expect(body.map((m: { month: string }) => m.month)).toEqual(['2026-02', '2026-03'])
  expect(body[0].income).toBe('0.00')
  expect(body[1]).toEqual({
    month: '2026-03',
    income: '3000.00',
    expenses: '2000.00',
    net: '1000.00',
    essential: '2000.00',
    flexible: '0.00',
    discretionary: '0.00',
    uncategorized: '0.00',
  })
})

it('test_by_category_maps_totals', async () => {
  const { app, db } = makeApp()
  const chk = makeAccount(db)
  const tx = makeTx(db, chk, '-40.00', 'COFFEE', '2026-03-03')
  categorize(db, tx.id, 'FOOD_AND_DRINK_COFFEE', 'discretionary')
  makeTx(db, chk, '-10.00', 'MYSTERY', '2026-03-04')

  const body = await getJson(app, '/api/reports/by-category?month=2026-03')
  expect(body.map((c: { total: string; count: number }) => [c.total, c.count])).toEqual([
    ['40.00', 1],
    ['10.00', 1],
  ])
  expect(body[1].category_id).toBeNull()
  expect(body[1].label).toBe('Uncategorized')
})

it('test_by_category_rejects_bad_month', async () => {
  const { app } = makeApp()
  expect((await app.request('/api/reports/by-category?month=2026-13')).status).toBe(400)
  expect((await app.request('/api/reports/by-category?month=March')).status).toBe(422)
})

it('test_balances_reconstruct_from_latest_snapshot', async () => {
  const { app, db } = makeApp()
  const chk = makeAccount(db, 'checking', 'Checking')
  snapshot(db, chk.id, '999.00', '2026-10-01') // older snapshot is ignored
  snapshot(db, chk.id, '1000.00', '2026-10-10')
  makeTx(db, chk, '-200.00', undefined, '2026-10-05')
  makeTx(db, chk, '-100.00', undefined, '2026-10-08')
  makeTx(db, chk, '50.00', undefined, '2026-10-10')
  const cc = makeAccount(db, 'credit', 'Card')
  snapshot(db, cc.id, '-500.00', '2026-10-12')
  makeTx(db, cc, '-100.00', undefined, '2026-10-11')
  makeTx(db, cc, '300.00', undefined, '2026-10-12')
  makeAccount(db, undefined, 'No snapshots')

  const body = await getJson(app, '/api/reports/balances?start=2026-10-04&end=2026-10-13')
  const series: Record<string, Record<string, string>> = Object.fromEntries(
    body.map((s: { name: string; points: { on: string; balance: string }[] }) => [
      s.name,
      Object.fromEntries(s.points.map((p) => [p.on, p.balance])),
    ]),
  )
  expect(new Set(Object.keys(series))).toEqual(new Set(['Checking', 'Card']))
  expect(Object.keys(series.Checking ?? {})).toHaveLength(10)
  expect(series.Checking).toEqual({
    '2026-10-04': '1250.00',
    '2026-10-05': '1050.00',
    '2026-10-06': '1050.00',
    '2026-10-07': '1050.00',
    '2026-10-08': '950.00',
    '2026-10-09': '950.00',
    '2026-10-10': '1000.00',
    '2026-10-11': '1000.00', // after the snapshot day: carried
    '2026-10-12': '1000.00',
    '2026-10-13': '1000.00',
  })
  expect(series.Card?.['2026-10-10']).toBe('-700.00')
  expect(series.Card?.['2026-10-11']).toBe('-800.00')
  expect(series.Card?.['2026-10-12']).toBe('-500.00')
  expect(series.Card?.['2026-10-13']).toBe('-500.00')
})

it('test_balances_default_to_180_days_ending_today', async () => {
  const { app, db } = makeApp()
  const chk = makeAccount(db)
  snapshot(db, chk.id, '100.00', TODAY)
  const points = (await getJson(app, '/api/reports/balances'))[0].points
  expect(points).toHaveLength(181)
  expect(points[0].on).toBe('2025-09-16')
  expect(points.at(-1).on).toBe('2026-03-15')
})

// Beyond test_reports.py: branches of reports.py the Python tests do not reach.

it('balances: start after end is an empty list', async () => {
  const { app, db } = makeApp()
  const chk = makeAccount(db)
  snapshot(db, chk.id, '100.00', TODAY)
  expect(await getJson(app, '/api/reports/balances?start=2026-03-10&end=2026-03-09')).toEqual([])
})

it('balances: an inactive account has no series; a lone start counts back from today', async () => {
  const { app, db } = makeApp()
  const chk = makeAccount(db, 'checking', 'Open')
  snapshot(db, chk.id, '100.00', TODAY)
  const closed = makeAccount(db, 'savings', 'Closed')
  snapshot(db, closed.id, '5.00', TODAY)
  db.$client.prepare('UPDATE accounts SET is_active = 0 WHERE id = ?').run(closed.id)
  const body = await getJson(app, '/api/reports/balances?start=2026-03-13')
  expect(body).toEqual([
    {
      account_id: chk.id,
      name: 'Open',
      points: [
        { on: '2026-03-13', balance: '100.00' },
        { on: '2026-03-14', balance: '100.00' },
        { on: '2026-03-15', balance: '100.00' },
      ],
    },
  ])
})

it('monthly: defaults to 12 months and enforces 1..60', async () => {
  const { app } = makeApp()
  const body = await getJson(app, '/api/reports/monthly')
  expect(body).toHaveLength(12)
  expect(body[0].month).toBe('2025-04')
  expect(body.at(-1).month).toBe('2026-03')
  expect((await app.request('/api/reports/monthly?months=0')).status).toBe(422)
  expect((await app.request('/api/reports/monthly?months=61')).status).toBe(422)
})

it('by-category: filters by essentiality', async () => {
  const { app, db } = makeApp()
  const chk = makeAccount(db)
  const tx = makeTx(db, chk, '-40.00', 'COFFEE', '2026-03-03')
  categorize(db, tx.id, 'FOOD_AND_DRINK_COFFEE', 'discretionary')
  makeTx(db, chk, '-10.00', 'MYSTERY', '2026-03-04')
  const body = await getJson(app, '/api/reports/by-category?month=2026-03&essentiality=unset')
  expect(body).toEqual([{ category_id: null, label: 'Uncategorized', primary: null, total: '10.00', count: 1 }])
})
