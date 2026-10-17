/** Ports api/tests/test_recurring.py. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/db/index.js'
import { type Essentiality, categorizations, recurrences, transactions } from '../src/db/schema.js'
import { type PlainDate, addDays, plainDate, utcNow } from '../src/lib/dates.js'
import { parseMoney } from '../src/lib/money.js'
import { detectRecurring } from '../src/services/recurring.js'
import { addMonths, nextAfter } from '../src/services/schedule.js'
import { type Account, categoryId, makeAccount, makeTx } from './factories.js'
import { makeDb } from './setup.js'

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

/** test_aggregates.categorize: a manual categorization of one transaction. */
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
  // Python's tests read the real date where they don't patch schedule.today; pin one so these
  // stay deterministic. It is the date these tests were ported on.
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
