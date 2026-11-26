/**
 * The balance projection, plus pins on the 28-digit decimal arithmetic of the variable
 * spending figures.
 */

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/db/index.js'
import {
  type Cadence,
  type Recurrence,
  type RecurrenceStatus,
  balanceSnapshots,
  manualEntries,
  recurrences,
} from '../src/db/schema.js'
import { type PlainDate, addDays, plainDate } from '../src/lib/dates.js'
import { parseMoney } from '../src/lib/money.js'
import { project, rateCents, rateTimes } from '../src/services/projection.js'
import { occurrences } from '../src/services/schedule.js'
import { makeAccount, makeTx } from './factories.js'
import { makeApp } from './setup.js'

const TODAY = plainDate('2026-10-15') // Thursday; 16 days remain in October
const d = (s: string): PlainDate => plainDate(s)

let ctx: ReturnType<typeof makeApp>
let db: Db

// fixed_today: schedule.today() is pinned through PLUTUS_TODAY.
beforeEach(() => {
  vi.stubEnv('PLUTUS_TODAY', TODAY)
  ctx = makeApp()
  db = ctx.db
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function charge(
  accountId: number,
  key: string,
  amount: string,
  cadence: Cadence,
  nxt: string,
  status: RecurrenceStatus = 'confirmed',
): void {
  db.insert(recurrences)
    .values({
      merchant_key: key,
      account_id: accountId,
      amount: parseMoney(amount),
      cadence,
      next_expected_date: d(nxt),
      status,
    })
    .run()
}

function entry(
  amount: string,
  due: string,
  rec: Recurrence = 'none',
  extra: { end_date?: PlainDate; fulfilled_transaction_id?: number } = {},
): void {
  db.insert(manualEntries)
    .values({ amount: parseMoney(amount), description: 'x', due_date: d(due), recurrence: rec, ...extra })
    .run()
}

function snapshot(accountId: number, balance: string): void {
  db.insert(balanceSnapshots)
    .values({ account_id: accountId, balance: parseMoney(balance), as_of: '2026-10-15T00:00:00.000Z' })
    .run()
}

interface Month {
  month: string
  [key: string]: string
}
interface Projection {
  as_of: string
  current_balance: string
  months: Month[]
  assumptions: string[]
}

async function getProjection(months?: number): Promise<Projection> {
  const res = await ctx.app.request(months === undefined ? '/api/projection' : `/api/projection?months=${months}`)
  expect(res.status).toBe(200)
  return (await res.json()) as Projection
}

describe('projection', () => {
  it('matches a hand-computed projection', async () => {
    const chk = makeAccount(db, 'checking')
    const cc = makeAccount(db, 'credit')
    snapshot(chk.id, '5000.00')
    snapshot(cc.id, '-1000.00')

    charge(chk.id, 'payroll', '2000.00', 'biweekly', '2026-10-16')
    charge(chk.id, 'rent', '-1500.00', 'monthly', '2026-11-01')
    charge(chk.id, 'netflix', '-15.00', 'monthly', '2026-10-20')
    charge(chk.id, 'proposed', '-99.00', 'monthly', '2026-10-18', 'proposed')

    entry('-200.00', '2026-10-25')
    entry('-30.00', '2026-10-31', 'monthly')
    entry('10.00', '2026-10-16', 'weekly', { end_date: d('2026-10-23') })
    entry('-77.00', '2026-10-10') // already past
    const paid = makeTx(db, chk, '-500.00', 'PAID', '2026-10-12')
    entry('-500.00', '2026-10-28', 'none', { fulfilled_transaction_id: paid.id })

    // Variable spending: Netflix (confirmed recurring), the transfer, income and old spend are out.
    makeTx(db, chk, '-900.00', 'GROCER', '2026-09-01')
    makeTx(db, chk, '-15.00', 'NETFLIX', '2026-09-20', { merchant_key: 'netflix' })
    makeTx(db, chk, '-500.00', 'TO SAVINGS', '2026-09-05', { is_transfer: true })
    makeTx(db, chk, '-1000.00', 'OLD', '2026-07-10') // outside the 90 days
    // income is not spending; it belongs to the confirmed payroll, so no variable income either
    makeTx(db, chk, '3000.00', 'PAYROLL', '2026-09-25', { merchant_key: 'payroll' })

    const body = await getProjection()
    expect(body.as_of).toBe('2026-10-15')
    expect(body.current_balance).toBe('4000.00')
    expect(body.months.map((m) => m.month)).toEqual(['2026-10', '2026-11', '2026-12'])
    // Variable spending counts the 900 grocery and the 500 "PAID" expense: 1400 over 90 days.
    const rows = body.months.map(({ month: _month, ...rest }) => rest)
    expect(rows[0]).toEqual({
      starting_balance: '4000.00',
      recurring_income: '4000.00', // Oct 16 + Oct 30
      recurring_expenses: '15.00',
      manual_income: '20.00',
      manual_expenses: '230.00',
      variable_spending: '248.89', // 1400 / 90 * 16
      variable_income: '0.00',
      projected_end_balance: '7526.11',
    })
    expect(rows[1]).toEqual({
      starting_balance: '7526.11',
      recurring_income: '4000.00', // Nov 13 + Nov 27
      recurring_expenses: '1515.00',
      manual_income: '0.00',
      manual_expenses: '30.00', // Nov 30
      variable_spending: '466.67', // 1400 / 90 * 30
      variable_income: '0.00',
      projected_end_balance: '9514.44',
    })
    expect(rows[2]?.variable_spending).toBe('482.22') // 1400 / 90 * 31
    expect(rows[2]?.projected_end_balance).toBe('11487.22')
    const text = body.assumptions.join(' ')
    expect(text).toContain('$15.56/day')
    expect(text).toContain('3 confirmed recurring items')
    expect(text).toContain('3 planned manual entries')
  })

  it('takes the months param and works on an empty database', async () => {
    const body = await getProjection(2)
    expect(body.current_balance).toBe('0.00')
    expect(body.months).toHaveLength(2)
    expect(body.months[1]?.projected_end_balance).toBe('0.00')
  })

  it('rolls over the year', async () => {
    vi.stubEnv('PLUTUS_TODAY', '2026-12-31')
    const { months } = await getProjection(2)
    expect(months.map((m) => m.month)).toEqual(['2026-12', '2027-01'])
  })

  it('rolls a stale next date forward', async () => {
    const chk = makeAccount(db)
    charge(chk.id, 'old', '-10.00', 'monthly', '2026-08-31')
    const { months } = await getProjection(2)
    expect(months[0]?.recurring_expenses).toBe('10.00') // Oct 31 (clamped series from Aug 31)
    expect(months[1]?.recurring_expenses).toBe('10.00') // Nov 30
  })

  it('schedule occurrences', () => {
    expect([...occurrences(d('2026-01-31'), 'monthly', d('2026-01-31'), d('2026-04-30'))]).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
    expect([...occurrences(d('2026-01-01'), 'none', d('2026-01-01'), d('2026-02-01'))]).toEqual([])
  })

  it('leaves a lapsed recurrence out but rolls a recent one forward', async () => {
    const chk = makeAccount(db)
    makeTx(db, chk, '-1.00', 'OLD', '2026-01-01') // keep a full 90-day window
    // Monthly: limit is 2 * 30 + 7 = 67 days. Last seen 66 days ago is live, 68 days is lapsed.
    charge(chk.id, 'live', '-10.00', 'monthly', '2026-09-01')
    charge(chk.id, 'dead', '-20.00', 'monthly', '2026-09-01')
    db.update(recurrences).set({ last_seen_on: addDays(TODAY, -66) }).where(eq(recurrences.merchant_key, 'live')).run()
    db.update(recurrences).set({ last_seen_on: addDays(TODAY, -68) }).where(eq(recurrences.merchant_key, 'dead')).run()
    const body = await getProjection(2)
    expect(body.months[0]?.recurring_expenses).toBe('0.00') // Oct 1 already passed
    expect(body.months[1]?.recurring_expenses).toBe('10.00') // rolled to Nov 1
    const text = body.assumptions.join(' ')
    expect(text).toContain('1 confirmed recurring item(s) left out')
    expect(text).toContain('1 confirmed recurring item is included')
  })

  it('divides a short history by the days covered', async () => {
    const chk = makeAccount(db)
    makeTx(db, chk, '-300.00', 'GROCER', addDays(TODAY, -30))
    makeTx(db, chk, '-600.00', 'BIG TRANSFER', addDays(TODAY, -100), { is_transfer: true })
    const body = await getProjection(1)
    // Earliest non-transfer is 30 days ago: 300 / 30 = 10.00/day over 16 days.
    expect(body.months[0]?.variable_spending).toBe('160.00')
    expect(body.assumptions.join(' ')).toContain('$10.00/day over the last 30 days (all the history there is)')
  })

  it('projects unconfirmed income through the average', () => {
    const chk = makeAccount(db)
    snapshot(chk.id, '1000.00')
    // A paycheck that is not (yet) a confirmed recurrence, and some spending.
    makeTx(db, chk, '2700.00', 'PAYROLL', '2026-09-30', { merchant_key: 'acme payroll' })
    makeTx(db, chk, '-900.00', 'GROCER', '2026-09-01')
    makeTx(db, chk, '-1.00', 'OLD', '2026-06-01') // history older than 90 days
    const october = project(db, 1).months[0]
    expect(october?.variable_income).toBe(parseMoney('480.00')) // 2700 / 90 * 16
    expect(october?.variable_spending).toBe(parseMoney('160.00')) // 900 / 90 * 16
    expect(october?.projected_end_balance).toBe(parseMoney('1320.00'))
  })

  it('counts two semimonthly paychecks per full month', async () => {
    const chk = makeAccount(db)
    charge(chk.id, 'payroll', '1500.00', 'semimonthly', '2026-10-31')
    const { months } = await getProjection(3)
    // Oct 31 (only one left in Oct), Nov 15 + Nov 30, Dec 15 + Dec 31.
    expect(months.map((m) => m.recurring_income)).toEqual(['1500.00', '3000.00', '3000.00'])
  })

  it('semimonthly annual cost and lapse', async () => {
    const chk = makeAccount(db)
    charge(chk.id, 'payroll', '1500.00', 'semimonthly', '2026-10-15')
    const res = await ctx.app.request('/api/recurring')
    const body = (await res.json()) as Array<{ annual_cost: string }>
    expect(body[0]?.annual_cost).toBe('36000.00')
    db.update(recurrences).set({ last_seen_on: addDays(TODAY, -38) }).run() // limit is 2 * 15 + 7 = 37
    const { months } = await getProjection(1)
    expect(months[0]?.recurring_income).toBe('0.00')
  })

  it('leaves one-time expenses out of the average', async () => {
    const chk = makeAccount(db)
    makeTx(db, chk, '-300.00', 'GROCER', addDays(TODAY, -30))
    makeTx(db, chk, '-9000.00', 'PARKING FINE', addDays(TODAY, -20), { one_time: true })
    const body = await getProjection(1)
    // Only the groceries count: 300 / 30 = 10.00/day over 16 days.
    expect(body.months[0]?.variable_spending).toBe('160.00')
    expect(body.assumptions.join(' ')).toContain('one-time transactions')
  })
})

describe('amount varies', () => {
  const VARIES = 'Bills whose amount varies use the same time last year where there is a year of history.'

  /** A confirmed monthly bill due 2026-11-05 with fifteen months of seasonal history. */
  function seasonalBill(varies: boolean): void {
    const chk = makeAccount(db)
    const bills = [
      ['-60.00', '2025-08-05'],
      ['-70.00', '2025-09-05'],
      ['-90.00', '2025-10-05'],
      ['-150.00', '2025-11-05'],
      ['-200.00', '2025-12-05'],
      ['-240.00', '2026-01-05'],
      ['-220.00', '2026-02-05'],
      ['-160.00', '2026-03-05'],
      ['-110.00', '2026-04-05'],
      ['-80.00', '2026-05-05'],
      ['-65.00', '2026-06-05'],
      ['-55.00', '2026-07-05'],
      ['-62.00', '2026-08-05'],
      ['-75.00', '2026-09-05'],
      ['-95.00', '2026-10-05'],
    ] as const
    for (const [amount, day] of bills) makeTx(db, chk, amount, 'GAS CO', day, { merchant_key: 'gas co' })
    db.insert(recurrences)
      .values({
        merchant_key: 'gas co',
        account_id: chk.id,
        amount: parseMoney('-70.00'), // the six-bill median
        cadence: 'monthly',
        next_expected_date: d('2026-11-05'),
        last_seen_on: d('2026-10-05'),
        status: 'confirmed',
        amount_varies: varies,
      })
      .run()
  }

  it('projects each bill from the same time last year', async () => {
    seasonalBill(true)
    const body = await getProjection(4)
    // Nov 5: Oct 5, Nov 5, Dec 5 last year (90, 150, 200). Dec 5: 150, 200, 240. Jan 5: 200, 240, 220.
    expect(body.months.map((m) => m.recurring_expenses)).toEqual(['0.00', '150.00', '200.00', '220.00'])
    const at = body.assumptions.indexOf(VARIES)
    expect(at).toBeGreaterThan(-1)
    expect(body.assumptions[at - 1]).toContain('1 confirmed recurring item is included')
  })

  it('projects an unflagged bill at its amount, without the assumption', async () => {
    seasonalBill(false)
    const body = await getProjection(4)
    expect(body.months.map((m) => m.recurring_expenses)).toEqual(['0.00', '70.00', '70.00', '70.00'])
    expect(body.assumptions).not.toContain(VARIES)
  })
})

describe('variable amounts use 28-digit decimal arithmetic (half even)', () => {
  // (total, window days, days) -> [cents(total / window * days), cents(total / window)].
  // 0.01 / 6 * 3 is exactly 0.005, which a single half-even division would round to 0.00; the
  // 28-digit quotient 0.001666...667 times 3 is 0.005000...001, which rounds to 0.01.
  const cases: Array<[string, number, number, string, string]> = [
    ['0.01', 6, 3, '0.01', '0.00'],
    ['0.05', 6, 3, '0.02', '0.01'],
    ['0.07', 6, 3, '0.04', '0.01'],
    ['1400.00', 90, 16, '248.89', '15.56'],
    ['0.03', 18, 3, '0.01', '0.00'],
    ['0.01', 14, 7, '0.00', '0.00'],
    ['100.03', 6, 3, '50.02', '16.67'],
    ['0.11', 66, 33, '0.06', '0.00'],
  ]
  it.each(cases)('%s over %i days, times %i', (total, window, days, amount, daily) => {
    const rate = { total: parseMoney(total), days: window }
    expect(rateTimes(rate, days)).toBe(parseMoney(amount))
    expect(rateCents(rate)).toBe(parseMoney(daily))
  })

  it('reaches the projection: a 0.005 tie rounds up through the 28-digit quotient', async () => {
    vi.stubEnv('PLUTUS_TODAY', '2026-10-28') // 3 days remain in October
    const chk = makeAccount(db)
    makeTx(db, chk, '-0.01', 'GROCER', '2026-10-22') // a 6-day window
    const body = await getProjection(1)
    expect(body.months[0]?.variable_spending).toBe('0.01')
    expect(body.months[0]?.projected_end_balance).toBe('-0.01')
    expect(body.assumptions[0]).toBe(
      'Variable spending averages $0.00/day over the last 6 days (all the history there is), ' +
        'excluding transfers, confirmed recurring charges, and one-time transactions.',
    )
  })
})

describe('assumptions', () => {
  it('are spelled verbatim', async () => {
    const body = await getProjection(1)
    expect(body.assumptions).toEqual([
      'Variable spending averages $0.00/day over the last 90 days, excluding transfers, confirmed ' +
        'recurring charges, and one-time transactions.',
      'Other income averages $0.00/day over the same period. Confirm paychecks on the Recurring ' +
        'page to project them on their actual dates.',
      '0 confirmed recurring items are included at their usual amounts and cadence.',
      '0 planned manual entries are included on their due dates.',
      'The current month counts only days after today.',
    ])
  })
})
