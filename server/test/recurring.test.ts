/** Recurring charge detection and management. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/db/index.js'
import {
  type Cadence,
  type Essentiality,
  type RecurrenceStatus,
  categorizations,
  recurrences,
  transactions,
} from '../src/db/schema.js'
import { type PlainDate, addDays, plainDate, utcNow } from '../src/lib/dates.js'
import { parseMoney } from '../src/lib/money.js'
import { detectRecurring } from '../src/services/recurring.js'
import { addMonths, nextAfter } from '../src/services/schedule.js'
import { type Account, categoryId, makeAccount, makeTx } from './factories.js'
import { makeApp, makeDb } from './setup.js'

const d = (s: string): PlainDate => plainDate(s)
const money = parseMoney

type TxExtra = Parameters<typeof makeTx>[5]

function series(db: Db, account: Account, key: string, amounts: string[], dates: string[], extra: TxExtra = {}): void {
  expect(amounts.length).toBe(dates.length) // zip(strict=True)
  amounts.forEach((amount, i) => {
    makeTx(db, account, amount, key.toUpperCase(), dates[i], { merchant_key: key, ...extra })
  })
}

function only(db: Db): typeof recurrences.$inferSelect {
  const rows = db.select().from(recurrences).all()
  expect(rows).toHaveLength(1)
  return rows[0] as typeof recurrences.$inferSelect
}

/** A manual categorization of one transaction. */
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

let db: Db

beforeEach(() => {
  // Pin today so these stay deterministic.
  vi.stubEnv('PLUTUS_TODAY', '2026-10-17')
  db = makeDb()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('detect_recurring', () => {
  it('detects monthly', () => {
    const acct = makeAccount(db)
    series(db, acct, 'netflix', ['-15.49', '-15.49', '-15.99'], ['2026-07-15', '2026-08-15', '2026-09-14'])
    expect(detectRecurring(db)).toBe(1)
    const r = only(db)
    expect([r.cadence, r.status]).toEqual(['monthly', 'proposed'])
    expect(r.amount).toBe(money('-15.49')) // median of the last three
    expect(r.last_seen_on).toBe('2026-09-14')
    expect(r.next_expected_date).toBe('2026-10-14')
    expect(r.essentiality).toBeNull()
  })

  it('monthly next date clamps to month end', () => {
    const acct = makeAccount(db)
    series(db, acct, 'gym', Array(3).fill('-30.00'), ['2026-11-30', '2026-12-31', '2027-01-31'])
    detectRecurring(db)
    expect(only(db).next_expected_date).toBe('2027-02-28')
    expect(addMonths(d('2028-01-31'), 1)).toBe('2028-02-29')
  })

  it('detects biweekly income', () => {
    const acct = makeAccount(db)
    const start = d('2026-08-07')
    series(
      db,
      acct,
      'acme payroll',
      Array(4).fill('2000.00'),
      [0, 1, 2, 3].map((i) => addDays(start, 14 * i)),
    )
    detectRecurring(db)
    const r = only(db)
    expect([r.cadence, r.amount]).toEqual(['biweekly', money('2000.00')])
    expect(r.next_expected_date).toBe('2026-10-02')
  })

  it('detects weekly', () => {
    const acct = makeAccount(db)
    const start = d('2026-09-01')
    series(db, acct, 'lunch club', Array(4).fill('-12.00'), [0, 1, 2, 3].map((i) => addDays(start, 7 * i)))
    detectRecurring(db)
    expect(only(db).cadence).toBe('weekly')
  })

  it('needs three occurrences', () => {
    const acct = makeAccount(db)
    series(db, acct, 'x', Array(2).fill('-9.00'), ['2026-08-01', '2026-09-01'])
    expect(detectRecurring(db)).toBe(0)
  })

  it('rejects inconsistent gaps', () => {
    const acct = makeAccount(db)
    series(db, acct, 'random', Array(4).fill('-10.00'), ['2026-01-01', '2026-01-05', '2026-03-01', '2026-03-04'])
    expect(detectRecurring(db)).toBe(0)
    expect(db.select().from(recurrences).all()).toEqual([])
  })

  it('tolerates one outlier gap in many', () => {
    const acct = makeAccount(db)
    const days = ['2026-01-05', '2026-02-05', '2026-03-05', '2026-03-20', '2026-04-20']
    series(db, acct, 'mostly monthly', Array(5).fill('-10.00'), days)
    expect(detectRecurring(db)).toBe(1)
  })

  it('rejects an amount swing over 15 percent', () => {
    const acct = makeAccount(db)
    series(db, acct, 'utility', ['-10.00', '-10.00', '-13.00'], ['2026-07-01', '2026-08-01', '2026-09-01'])
    expect(detectRecurring(db)).toBe(0)
  })

  it('still detects an occasional outlier amount', () => {
    // Owner-like paychecks: 7 regular, one bonus, one double payment.
    const acct = makeAccount(db)
    const amounts = ['2740.00', '2000.00', '2000.00', '2000.00', '2000.00', '4100.00', '2000.00', '2000.00', '2000.00']
    const days = [
      '2026-05-15', '2026-05-29', '2026-06-15', '2026-06-30',
      '2026-07-15', '2026-07-31', '2026-08-14', '2026-08-31',
      '2026-09-15',
    ]
    series(db, acct, 'acme payroll', amounts, days)
    expect(detectRecurring(db)).toBe(1)
    const row = only(db)
    expect(row.cadence).toBe('semimonthly')
    expect(row.amount).toBe(money('2000.00'))
  })

  it('a reversal in the same merchant does not hide a paycheck', () => {
    const acct = makeAccount(db)
    const days = [6, 7, 8].flatMap((m) => [15, 28].map((day) => `2026-0${m}-${day}`))
    series(db, acct, 'acme payroll', Array(days.length).fill('2000.00'), days)
    series(db, acct, 'acme payroll', ['-35.00'], ['2026-06-03']) // a correction
    expect(detectRecurring(db)).toBe(1)
    expect(only(db).amount).toBe(money('2000.00'))
  })

  it('ignores transfers and pending', () => {
    const acct = makeAccount(db)
    const days = ['2026-07-01', '2026-08-01', '2026-09-01']
    series(db, acct, 'xfer', Array(3).fill('-50.00'), days, { is_transfer: true })
    series(db, acct, 'pend', Array(3).fill('-50.00'), days, { pending: true })
    expect(detectRecurring(db)).toBe(0)
  })

  it('the same merchant on two accounts is two groups', () => {
    const a = makeAccount(db)
    const b = makeAccount(db)
    const days = ['2026-07-01', '2026-08-01', '2026-09-01']
    series(db, a, 'spotify', Array(3).fill('-10.00'), days)
    series(db, b, 'spotify', Array(3).fill('-10.00'), days)
    expect(detectRecurring(db)).toBe(2)
  })

  it('takes essentiality from the latest categorization', () => {
    const acct = makeAccount(db)
    series(db, acct, 'netflix', Array(3).fill('-15.00'), ['2026-07-01', '2026-08-01', '2026-09-01'])
    expect(db.select({ id: recurrences.id }).from(recurrences).all()).toEqual([])
    const ids = db
      .select({ id: transactions.id })
      .from(transactions)
      .orderBy(transactions.posted_on)
      .all()
      .map((r) => r.id)
    categorize(db, ids[0] as number, 'ENTERTAINMENT_TV_AND_MOVIES', 'flexible')
    categorize(db, ids[2] as number, 'ENTERTAINMENT_TV_AND_MOVIES', 'discretionary')
    detectRecurring(db)
    expect(only(db).essentiality).toBe('discretionary')
  })

  it('never touches or recreates a dismissed one', () => {
    const acct = makeAccount(db)
    series(db, acct, 'netflix', Array(3).fill('-15.00'), ['2026-07-01', '2026-08-01', '2026-09-01'])
    db.insert(recurrences)
      .values({
        merchant_key: 'netflix',
        account_id: acct.id,
        amount: money('-1.00'),
        cadence: 'weekly',
        next_expected_date: d('2026-01-01'),
        status: 'dismissed',
      })
      .run()
    expect(detectRecurring(db)).toBe(0)
    const r = only(db)
    expect([r.status, r.amount, r.cadence, r.next_expected_date]).toEqual([
      'dismissed',
      money('-1.00'),
      'weekly',
      '2026-01-01',
    ])
  })

  it('confirmed keeps its status but refreshes', () => {
    const acct = makeAccount(db)
    series(db, acct, 'netflix', Array(3).fill('-15.00'), ['2026-07-01', '2026-08-01', '2026-09-01'])
    db.insert(recurrences)
      .values({
        merchant_key: 'netflix',
        account_id: acct.id,
        amount: money('-14.00'),
        cadence: 'monthly',
        next_expected_date: d('2026-09-01'),
        last_seen_on: d('2026-08-01'),
        status: 'confirmed',
        essentiality: 'essential',
      })
      .run()
    expect(detectRecurring(db)).toBe(1)
    const r = only(db)
    expect(r.status).toBe('confirmed')
    expect(r.amount).toBe(money('-15.00'))
    expect(r.last_seen_on).toBe('2026-09-01')
    expect(r.next_expected_date).toBe('2026-10-01')
    expect(r.essentiality).toBe('essential')
    expect(detectRecurring(db)).toBe(0) // idempotent
  })

  it('counts a refresh that also fills essentiality once (backlog 3)', () => {
    const acct = makeAccount(db)
    series(db, acct, 'netflix', Array(3).fill('-15.00'), ['2026-07-01', '2026-08-01', '2026-09-01'])
    const lastTx = db
      .select({ id: transactions.id })
      .from(transactions)
      .orderBy(transactions.posted_on)
      .all()
      .at(-1) as { id: number }
    categorize(db, lastTx.id, 'ENTERTAINMENT_TV_AND_MOVIES', 'discretionary')
    db.insert(recurrences)
      .values({
        merchant_key: 'netflix',
        account_id: acct.id,
        amount: money('-14.00'),
        cadence: 'monthly',
        next_expected_date: d('2026-09-01'),
        last_seen_on: d('2026-08-01'),
        status: 'confirmed',
      })
      .run()
    expect(detectRecurring(db)).toBe(1)
    const r = only(db)
    expect([r.amount, r.last_seen_on, r.essentiality]).toEqual([money('-15.00'), '2026-09-01', 'discretionary'])
    expect(detectRecurring(db)).toBe(0)
  })

  it('an undetectable charge takes the latest amount when it shows up again (backlog 5)', () => {
    const acct = makeAccount(db, 'credit')
    series(db, acct, 'annual fee', ['-325.00'], ['2025-09-16'])
    db.insert(recurrences)
      .values({
        merchant_key: 'annual fee',
        account_id: acct.id,
        amount: money('-325.00'),
        cadence: 'yearly',
        next_expected_date: d('2026-09-16'),
        last_seen_on: d('2025-09-16'),
        status: 'confirmed',
      })
      .run()
    series(db, acct, 'annual fee', ['-350.00'], ['2026-09-15'])
    expect(detectRecurring(db)).toBe(1)
    const r = only(db)
    expect([r.amount, r.last_seen_on, r.next_expected_date]).toEqual([money('-350.00'), '2026-09-15', '2027-09-15'])
    expect(detectRecurring(db)).toBe(0)
  })

  it('ignores history older than 18 months', () => {
    vi.stubEnv('PLUTUS_TODAY', '2026-10-03')
    const acct = makeAccount(db)
    series(db, acct, 'old', Array(3).fill('-10.00'), ['2025-01-05', '2025-02-05', '2025-03-05'])
    expect(detectRecurring(db)).toBe(0)
    series(db, acct, 'recent', Array(3).fill('-10.00'), ['2026-07-05', '2026-08-05', '2026-09-05'])
    expect(detectRecurring(db)).toBe(1)
  })
})

/** month_ends_and_fifteenths: the 15th and the last day of each month. */
function monthEndsAndFifteenths(startYear: number, startMonth: number, months: number): PlainDate[] {
  const out: PlainDate[] = []
  const start = d(`${startYear}-${String(startMonth).padStart(2, '0')}-01`)
  for (let i = 0; i < months; i += 1) {
    const first = addMonths(start, i)
    out.push(d(`${first.slice(0, 8)}15`))
    out.push(addDays(addMonths(first, 1), -1))
  }
  return out
}

describe('semimonthly detection', () => {
  it('detects owner-like semimonthly gaps', () => {
    const acct = makeAccount(db)
    const days = monthEndsAndFifteenths(2026, 1, 9) // Jan 15 ... Sep 30
    series(db, acct, 'acme payroll', Array(days.length).fill('2500.00'), days)
    detectRecurring(db)
    const r = only(db)
    expect(r.cadence).toBe('semimonthly')
    expect(r.amount).toBe(money('2500.00'))
    expect(r.next_expected_date).toBe('2026-10-15')
  })

  it('detects semimonthly with jittered pay days', () => {
    const acct = makeAccount(db)
    const days = [
      '2026-06-15', '2026-06-30', '2026-07-15', '2026-07-31',
      '2026-08-14', '2026-08-31', '2026-09-15', '2026-09-30',
    ]
    series(db, acct, 'acme payroll', Array(days.length).fill('2500.00'), days)
    detectRecurring(db)
    expect(only(db).cadence).toBe('semimonthly')
  })

  it('a true biweekly is not semimonthly', () => {
    const acct = makeAccount(db)
    const start = d('2026-03-06')
    const days = Array.from({ length: 12 }, (_, i) => addDays(start, 14 * i))
    series(db, acct, 'acme payroll', Array(days.length).fill('2000.00'), days)
    detectRecurring(db)
    expect(only(db).cadence).toBe('biweekly')
  })

  it('next dates alternate and clamp', () => {
    expect(nextAfter(d('2026-09-15'), 'semimonthly')).toBe('2026-09-30')
    expect(nextAfter(d('2026-09-30'), 'semimonthly')).toBe('2026-10-15')
    expect(nextAfter(d('2026-02-15'), 'semimonthly')).toBe('2026-02-28')
    expect(nextAfter(d('2026-02-28'), 'semimonthly')).toBe('2026-03-15')
    expect(nextAfter(d('2026-12-31'), 'semimonthly')).toBe('2027-01-15')
    expect(nextAfter(d('2026-09-01'), 'semimonthly')).toBe('2026-09-16')
    expect(nextAfter(d('2026-09-16'), 'semimonthly')).toBe('2026-10-01')
  })
})

// Routes.

type Row = Record<string, unknown>

function makeCharge(db: Db, key: string, amount: string, status: RecurrenceStatus, cadence: Cadence = 'monthly') {
  const acct = makeAccount(db)
  return db
    .insert(recurrences)
    .values({
      merchant_key: key,
      account_id: acct.id,
      amount: money(amount),
      cadence,
      next_expected_date: d('2026-10-20'),
      last_seen_on: d('2026-09-20'),
      status,
    })
    .returning()
    .get()
}

function client() {
  const { app } = makeApp({ db })
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    })
  return {
    get: (path: string) => send('GET', path),
    post: (path: string, body: unknown) => send('POST', path, body),
    patch: (path: string, body: unknown) => send('PATCH', path, body),
  }
}

describe('recurring routes', () => {
  it('lists proposed and confirmed by default', async () => {
    makeCharge(db, 'a', '-10.00', 'proposed')
    makeCharge(db, 'b', '-20.00', 'confirmed')
    makeCharge(db, 'c', '-30.00', 'dismissed')
    const c = client()
    const body = (await (await c.get('/api/recurring')).json()) as Row[]
    expect(body.map((r) => r.merchant_key).sort()).toEqual(['a', 'b'])
    const onlyDismissed = (await (await c.get('/api/recurring?status=dismissed')).json()) as Row[]
    expect(onlyDismissed.map((r) => r.merchant_key)).toEqual(['c'])
  })

  it('signs the annual cost', async () => {
    makeCharge(db, 'rent', '-100.00', 'confirmed', 'monthly')
    makeCharge(db, 'pay', '1000.00', 'confirmed', 'biweekly')
    makeCharge(db, 'gym', '-5.00', 'confirmed', 'weekly')
    makeCharge(db, 'ins', '-300.00', 'confirmed', 'yearly')
    const body = (await (await client().get('/api/recurring')).json()) as Row[]
    const costs = Object.fromEntries(body.map((r) => [r.merchant_key, r.annual_cost]))
    expect(costs).toEqual({ rent: '-1200.00', pay: '26000.00', gym: '-260.00', ins: '-300.00' })
  })

  it('patch updates fields', async () => {
    const charge = makeCharge(db, 'a', '-10.00', 'proposed')
    const c = client()
    const resp = await c.patch(`/api/recurring/${charge.id}`, {
      status: 'confirmed',
      essentiality: 'flexible',
      amount: '-12.50',
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as Row
    expect([body.status, body.essentiality, body.amount]).toEqual(['confirmed', 'flexible', '-12.50'])
    expect(body.next_expected_date).toBe('2026-10-20') // unchanged without a cadence change
    const cleared = (await (await c.patch(`/api/recurring/${charge.id}`, { essentiality: null })).json()) as Row
    expect(cleared.essentiality).toBeNull()
  })

  it('patch cadence recomputes the next date', async () => {
    const charge = makeCharge(db, 'a', '-10.00', 'confirmed')
    const body = (await (await client().patch(`/api/recurring/${charge.id}`, { cadence: 'weekly' })).json()) as Row
    expect(body.cadence).toBe('weekly')
    expect(body.next_expected_date).toBe('2026-09-27')
  })

  it('patch unknown is 404', async () => {
    expect((await client().patch('/api/recurring/999999', { status: 'confirmed' })).status).toBe(404)
  })

  it('marks a yearly fee as recurring and keeps it current', async () => {
    const acct = makeAccount(db, 'credit')
    const fee = makeTx(db, acct, '-325.00', 'RENEWAL MEMBERSHIP FEE', '2026-09-16', {
      merchant_key: 'RENEWAL MEMBERSHIP FEE',
    })
    const res = await client().post('/api/recurring', { transaction_id: fee.id, cadence: 'yearly' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Row
    expect([body.status, body.cadence, body.amount]).toEqual(['confirmed', 'yearly', '-325.00'])
    expect(body.next_expected_date).toBe('2027-09-16')
    expect(body.annual_cost).toBe('-325.00')
    // Next year's renewal: one occurrence isn't detectable, but the confirmed row stays current.
    makeTx(db, acct, '-350.00', 'RENEWAL MEMBERSHIP FEE', '2027-09-15', { merchant_key: 'RENEWAL MEMBERSHIP FEE' })
    detectRecurring(db)
    const row = only(db)
    expect(row.last_seen_on).toBe('2027-09-15')
    expect(row.next_expected_date).toBe('2028-09-15')
    expect(row.status).toBe('confirmed')
    expect(row.amount).toBe(money('-350.00')) // backlog 5: the renewal's new price
  })

  it('mark confirms a dismissed one and rejects transfers', async () => {
    vi.stubEnv('PLUTUS_TODAY', '2026-09-20')
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-4.99', 'AMAZON PRIME', '2026-09-03', { merchant_key: 'AMAZON PRIME' })
    db.insert(recurrences)
      .values({
        merchant_key: 'AMAZON PRIME',
        account_id: acct.id,
        amount: money('-4.99'),
        cadence: 'monthly',
        next_expected_date: d('2026-10-03'),
        status: 'dismissed',
      })
      .run()
    const transfer = makeTx(db, acct, '-500.00', 'TO SAVINGS', '2026-09-05', {
      is_transfer: true,
      merchant_key: 'TO SAVINGS',
    })
    const c = client()
    const body = (await (await c.post('/api/recurring', { transaction_id: tx.id, cadence: 'monthly' })).json()) as Row
    expect(body.status).toBe('confirmed')
    expect(body.next_expected_date).toBe('2026-10-03')
    expect((await c.post('/api/recurring', { transaction_id: transfer.id, cadence: 'monthly' })).status).toBe(400)
    expect((await c.post('/api/recurring', { transaction_id: 999999, cadence: 'monthly' })).status).toBe(404)
  })
})

describe('recurring names', () => {
  it("names a charge by its latest matching payee on the same account, else its key", async () => {
    const acct = makeAccount(db)
    const other = makeAccount(db)
    const key = 'netflix com'
    makeTx(db, acct, '-15.49', 'NETFLIX.COM 1', '2026-08-03', { merchant_key: key, payee: 'Netflix Old' })
    makeTx(db, acct, '-15.49', 'NETFLIX.COM 2', '2026-09-03', { merchant_key: key, payee: 'Netflix' })
    makeTx(db, acct, '-15.49', 'NETFLIX.COM 3', '2026-10-03', { merchant_key: key, payee: null })
    makeTx(db, other, '-15.49', 'NETFLIX.COM 4', '2026-10-04', { merchant_key: key, payee: 'Elsewhere' })
    const values = { amount: money('-15.49'), cadence: 'monthly' as const, next_expected_date: d('2026-11-03'), status: 'confirmed' as const }
    db.insert(recurrences).values({ merchant_key: key, account_id: acct.id, ...values }).run()
    db.insert(recurrences).values({ merchant_key: 'gym co', account_id: acct.id, ...values }).run()
    const body = (await (await client().get('/api/recurring')).json()) as Row[]
    const names = Object.fromEntries(body.map((r) => [r.merchant_key, r.name]))
    expect(names).toEqual({ [key]: 'Netflix', 'gym co': 'gym co' })
  })

  it('names the charge in the mark response', async () => {
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-9.99', 'SPOTIFY P1234', '2026-10-01', { merchant_key: 'spotify', payee: 'Spotify' })
    const body = (await (await client().post('/api/recurring', { transaction_id: tx.id, cadence: 'monthly' })).json()) as Row
    expect(body.name).toBe('Spotify')
  })
})

describe('amount varies', () => {
  const BILLS = [
    ['-80.00', '2026-04-05'],
    ['-95.00', '2026-05-05'],
    ['-120.00', '2026-06-05'],
    ['-210.00', '2026-07-05'],
    ['-180.00', '2026-08-05'],
    ['-140.00', '2026-09-05'],
    ['-100.00', '2026-10-05'],
  ] as const

  /** Seven uneven monthly utility bills; returns the account and the latest one. */
  function utility() {
    const acct = makeAccount(db)
    const txs = BILLS.map(([amount, day]) => makeTx(db, acct, amount, 'CON EDISON', day, { merchant_key: 'con edison' }))
    return { acct, last: txs.at(-1) as (typeof txs)[number] }
  }

  it('is never proposed by detection and is off by default', async () => {
    const { last } = utility()
    expect(detectRecurring(db)).toBe(0)
    const body = (await (await client().post('/api/recurring', { transaction_id: last.id, cadence: 'monthly' })).json()) as Row
    expect([body.amount, body.amount_varies]).toEqual(['-100.00', false])
  })

  it('marking with amount_varies estimates the median of the last six bills', async () => {
    const { last } = utility()
    const res = await client().post('/api/recurring', { transaction_id: last.id, cadence: 'monthly', amount_varies: true })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Row
    // Last six: 95, 120, 210, 180, 140, 100; the middle two are 120 and 140.
    expect([body.amount, body.amount_varies, body.annual_cost]).toEqual(['-130.00', true, '-1560.00'])
  })

  it('keeps the estimate current as bills arrive', async () => {
    const { acct, last } = utility()
    await client().post('/api/recurring', { transaction_id: last.id, cadence: 'monthly', amount_varies: true })
    makeTx(db, acct, '-300.00', 'CON EDISON', '2026-11-05', { merchant_key: 'con edison' })
    detectRecurring(db)
    const row = only(db)
    // Last six: 120, 210, 180, 140, 100, 300; the middle two are 140 and 180.
    expect(row.amount).toBe(money('-160.00'))
    expect([row.last_seen_on, row.next_expected_date, row.amount_varies]).toEqual(['2026-11-05', '2026-12-05', true])
  })

  it('patching amount_varies re-estimates; off goes back to the last three', async () => {
    const { last } = utility()
    const c = client()
    const marked = (await (await c.post('/api/recurring', { transaction_id: last.id, cadence: 'monthly' })).json()) as Row
    const on = (await (await c.patch(`/api/recurring/${String(marked.id)}`, { amount_varies: true })).json()) as Row
    expect([on.amount, on.amount_varies]).toEqual(['-130.00', true])
    const off = (await (await c.patch(`/api/recurring/${String(marked.id)}`, { amount_varies: false })).json()) as Row
    expect([off.amount, off.amount_varies]).toEqual(['-140.00', false]) // median of 180, 140, 100
  })

  it('marking again without amount_varies keeps the setting', async () => {
    const { last } = utility()
    const c = client()
    await c.post('/api/recurring', { transaction_id: last.id, cadence: 'monthly', amount_varies: true })
    const again = (await (await c.post('/api/recurring', { transaction_id: last.id, cadence: 'monthly' })).json()) as Row
    expect([again.amount, again.amount_varies]).toEqual(['-130.00', true])
  })
})
