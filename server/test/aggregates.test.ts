/**
 * Ports api/tests/test_aggregates.py. The tests under "beyond test_aggregates.py" pin the
 * aggregates functions the Python suite only reaches through projection, goals, and changes
 * (other briefs' tests), read off the docstrings in api/app/services/aggregates.py.
 */

import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Db } from '../src/db/index.js'
import { type Essentiality, accounts, balanceSnapshots, categorizations } from '../src/db/schema.js'
import { plainDate as d8, utcNow } from '../src/lib/dates.js'
import { parseMoney } from '../src/lib/money.js'
import {
  INCOME_PRIMARIES,
  MONEY_MOVEMENT,
  categoryTotals,
  currentTotalBalance,
  expenseAmounts,
  expenseIds,
  expensesBetween,
  incomeBetween,
  largestExpenseIds,
  monthRange,
  monthlyTotals,
  recentActiveMonths,
} from '../src/services/aggregates.js'
import { categoryId, makeAccount, makeTx } from './factories.js'
import { makeDb } from './setup.js'

const m = parseMoney

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

function snapshot(db: Db, accountId: number, balance: string, asOf: string): void {
  db.insert(balanceSnapshots).values({ account_id: accountId, balance: m(balance), as_of: asOf }).run()
}

it('test_month_range_crosses_year_boundary', () => {
  expect(monthRange(d8('2026-02-15'), 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
})

it('test_monthly_totals_definitions', () => {
  const db = makeDb()
  const chk = makeAccount(db, 'checking')
  const sav = makeAccount(db, 'savings')
  const d = '2026-03-10'
  const salary = makeTx(db, chk, '3000.00', 'ACME PAYROLL', d)
  categorize(db, salary.id, 'INCOME_SALARY')
  const coffee = makeTx(db, chk, '-5.50', 'COFFEE', d)
  categorize(db, coffee.id, 'FOOD_AND_DRINK_COFFEE', 'discretionary')
  const rent = makeTx(db, chk, '-2000.00', 'RENT', d)
  categorize(db, rent.id, 'RENT_AND_UTILITIES_RENT', 'essential')
  const refund = makeTx(db, chk, '20.00', 'STORE REFUND', d)
  categorize(db, refund.id, 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE', 'flexible')
  makeTx(db, chk, '-30.00', 'MYSTERY CHARGE', d) // uncategorized expense
  makeTx(db, chk, '15.00', 'MYSTERY DEPOSIT', d) // uncategorized money in counts as income
  makeTx(db, chk, '-500.00', 'TO SAVINGS', d, { is_transfer: true })
  makeTx(db, sav, '500.00', 'FROM CHECKING', d, { is_transfer: true })

  const [feb, mar] = monthlyTotals(db, ['2026-02', '2026-03'])
  expect(feb?.income).toBe(0)
  expect(feb?.expenses).toBe(0)
  expect(mar?.income).toBe(m('3015.00'))
  expect(mar?.expenses).toBe(m('2015.50')) // 5.50 + 2000 - 20 refund + 30
  expect(mar?.essential).toBe(m('2000.00'))
  expect(mar?.discretionary).toBe(m('5.50'))
  expect(mar?.flexible).toBe(m('-20.00')) // a refund-only month can go negative
  expect(mar?.uncategorized).toBe(m('30.00'))
  expect(mar?.net).toBe(m('999.50'))
})

it('test_category_totals', () => {
  const db = makeDb()
  const chk = makeAccount(db)
  for (const [day, amount] of [
    ['2026-03-01', '-4.00'],
    ['2026-04-02', '-6.00'],
  ] as const) {
    const tx = makeTx(db, chk, amount, 'COFFEE', day)
    categorize(db, tx.id, 'FOOD_AND_DRINK_COFFEE')
  }
  const rent = makeTx(db, chk, '-1000.00', 'RENT', '2026-04-01')
  categorize(db, rent.id, 'RENT_AND_UTILITIES_RENT')
  makeTx(db, chk, '-7.00', 'MYSTERY', '2026-04-03')
  const pay = makeTx(db, chk, '100.00', 'PAY', '2026-04-03')
  categorize(db, pay.id, 'INCOME_SALARY')

  const rows = categoryTotals(db, ['2026-03', '2026-04'])
  expect(rows.map((r) => r.label)).toEqual(['Rent', 'Coffee', 'Uncategorized'])
  const coffee = rows[1]
  expect(coffee?.total).toBe(m('10.00'))
  expect(coffee?.count).toBe(2)
  expect(coffee?.monthly).toEqual({ '2026-03': m('4.00'), '2026-04': m('6.00') })
  expect(rows[2]?.category_id).toBeNull()
})

it('test_current_total_balance_uses_latest_snapshot_of_active_accounts', () => {
  const db = makeDb()
  const chk = makeAccount(db, 'checking')
  const cc = makeAccount(db, 'credit')
  const closed = makeAccount(db, 'savings')
  db.update(accounts).set({ is_active: false }).where(eq(accounts.id, closed.id)).run()
  const t0 = '2026-09-01T00:00:00.000Z'
  const t1 = '2026-09-02T00:00:00.000Z'
  snapshot(db, chk.id, '100.00', t0)
  snapshot(db, chk.id, '250.00', t1)
  snapshot(db, cc.id, '-40.00', t1)
  snapshot(db, closed.id, '999.00', t1)
  expect(currentTotalBalance(db)).toBe(m('210.00'))
})

it('test_category_totals_filtered_by_essentiality', () => {
  const db = makeDb()
  const chk = makeAccount(db)
  const d = '2026-05-03'
  const rent = makeTx(db, chk, '-1000.00', 'RENT', d)
  categorize(db, rent.id, 'RENT_AND_UTILITIES_RENT', 'essential')
  const coffee = makeTx(db, chk, '-6.00', 'COFFEE', d)
  categorize(db, coffee.id, 'FOOD_AND_DRINK_COFFEE', 'discretionary')
  const gift = makeTx(db, chk, '-40.00', 'GIFT', d)
  categorize(db, gift.id, 'GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES') // no essentiality
  makeTx(db, chk, '-9.00', 'MYSTERY', d) // uncategorized

  const labels = (f: 'essential' | 'discretionary' | 'unset') => categoryTotals(db, ['2026-05'], f).map((r) => r.label)

  expect(labels('essential')).toEqual(['Rent'])
  expect(labels('discretionary')).toEqual(['Coffee'])
  expect(labels('unset')).toEqual(['Gifts and novelties', 'Uncategorized'])
})

it('test_money_movement_excluded_and_deposits_are_income', () => {
  const db = makeDb()
  const chk = makeAccount(db, 'checking')
  const d = '2026-06-10'
  const cardPayment = makeTx(db, chk, '-900.00', 'PAYMENT TO CARD', d) // card not linked/paired
  categorize(db, cardPayment.id, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'essential')
  const toSavings = makeTx(db, chk, '-500.00', 'TO SAVINGS', d)
  categorize(db, toSavings.id, 'TRANSFER_OUT_SAVINGS')
  const deposit = makeTx(db, chk, '300.00', 'ATM DEPOSIT', d)
  categorize(db, deposit.id, 'TRANSFER_IN_DEPOSIT')
  const venmo = makeTx(db, chk, '-60.00', 'VENMO', d) // P2P stays real spending
  categorize(db, venmo.id, 'TRANSFER_OUT_TRANSFER_OUT_FROM_APPS', 'discretionary')
  const loan = makeTx(db, chk, '-250.00', 'LOAN', d) // debt service stays counted
  categorize(db, loan.id, 'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT', 'essential')

  const [june] = monthlyTotals(db, ['2026-06'])
  expect(june?.income).toBe(m('300.00'))
  expect(june?.expenses).toBe(m('310.00')) // 60 + 250
  expect(june?.essential).toBe(m('250.00'))
  const labels = categoryTotals(db, ['2026-06']).map((r) => r.label)
  expect(labels).not.toContain('Credit card payment')
  expect(labels).not.toContain('Savings')
})

describe('beyond test_aggregates.py', () => {
  it('keeps INCOME_PRIMARIES and MONEY_MOVEMENT unchanged', () => {
    expect(INCOME_PRIMARIES).toEqual(['INCOME', 'TRANSFER_IN'])
    expect(MONEY_MOVEMENT).toEqual([
      'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
      'TRANSFER_IN_ACCOUNT_TRANSFER',
      'TRANSFER_OUT_ACCOUNT_TRANSFER',
      'TRANSFER_IN_SAVINGS',
      'TRANSFER_OUT_SAVINGS',
      'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS',
      'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
    ])
  })

  it('returns nothing for no months', () => {
    const db = makeDb()
    expect(monthlyTotals(db, [])).toEqual([])
    expect(categoryTotals(db, [])).toEqual([])
  })

  it('zero-fills months with no activity, net included', () => {
    const db = makeDb()
    expect(monthlyTotals(db, ['2026-01'])).toEqual([
      {
        month: '2026-01',
        income: 0,
        expenses: 0,
        essential: 0,
        flexible: 0,
        discretionary: 0,
        uncategorized: 0,
        net: 0,
      },
    ])
  })

  it('counts categorized spending without essentiality as uncategorized in the buckets', () => {
    const db = makeDb()
    const chk = makeAccount(db)
    const gift = makeTx(db, chk, '-40.00', 'GIFT', '2026-05-03')
    categorize(db, gift.id, 'GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES')
    const [may] = monthlyTotals(db, ['2026-05'])
    expect(may?.uncategorized).toBe(m('40.00'))
    expect(may?.expenses).toBe(m('40.00'))
  })

  it('through_day limits every month to its first N days, by day of month', () => {
    const db = makeDb()
    const chk = makeAccount(db)
    makeTx(db, chk, '-10.00', 'A', '2026-03-09')
    makeTx(db, chk, '-20.00', 'B', '2026-03-10')
    makeTx(db, chk, '-40.00', 'C', '2026-03-11')
    makeTx(db, chk, '-80.00', 'D', '2026-04-10')
    makeTx(db, chk, '-160.00', 'E', '2026-04-30')
    const totals = monthlyTotals(db, ['2026-03', '2026-04'], 10)
    expect(totals.map((t) => t.expenses)).toEqual([m('30.00'), m('80.00')])
    const cats = categoryTotals(db, ['2026-03', '2026-04'], null, 10)
    expect(cats).toEqual([
      { category_id: null, label: 'Uncategorized', primary: null, total: m('110.00'), count: 3, monthly: { '2026-03': m('30.00'), '2026-04': m('80.00') } },
    ])
  })

  it('recent_active_months: up to n prior months with activity, oldest first, within a year', () => {
    const db = makeDb()
    const chk = makeAccount(db)
    makeTx(db, chk, '-1.00', 'OLD', '2025-08-15') // 13 months before September 2026: outside
    makeTx(db, chk, '-2.00', 'A', '2025-09-15')
    makeTx(db, chk, '5.00', 'B', '2026-02-15') // income alone counts as activity
    makeTx(db, chk, '-3.00', 'C', '2026-05-15')
    makeTx(db, chk, '-4.00', 'D', '2026-08-15')
    makeTx(db, chk, '-9.00', 'SAME MONTH', '2026-09-01') // the month itself is excluded
    expect(recentActiveMonths(db, '2026-09').map((t) => t.month)).toEqual(['2026-02', '2026-05', '2026-08'])
    expect(recentActiveMonths(db, '2026-09', 5).map((t) => t.month)).toEqual(['2025-09', '2026-02', '2026-05', '2026-08'])
    expect(recentActiveMonths(db, '2026-09', 1).map((t) => t.month)).toEqual(['2026-08'])
  })

  it('a month whose income and expenses cancel to zero is not active', () => {
    const db = makeDb()
    const chk = makeAccount(db)
    const refund = makeTx(db, chk, '10.00', 'REFUND', '2026-08-02')
    categorize(db, refund.id, 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE')
    makeTx(db, chk, '-10.00', 'SHOP', '2026-08-01')
    expect(recentActiveMonths(db, '2026-09')).toEqual([])
  })

  it('expenses_between and income_between share the definitions, end exclusive', () => {
    const db = makeDb()
    const chk = makeAccount(db)
    makeTx(db, chk, '-10.00', 'NETFLIX', '2026-03-01', { merchant_key: 'NETFLIX' })
    makeTx(db, chk, '-20.00', 'FINE', '2026-03-02', { one_time: true })
    makeTx(db, chk, '-40.00', 'NO KEY', '2026-03-03')
    makeTx(db, chk, '-80.00', 'NEXT MONTH', '2026-04-01')
    makeTx(db, chk, '-500.00', 'TRANSFER', '2026-03-04', { is_transfer: true })
    makeTx(db, chk, '1000.00', 'PAYROLL', '2026-03-05', { merchant_key: 'ACME' })
    makeTx(db, chk, '7.00', 'DEPOSIT', '2026-03-06')
    const refund = makeTx(db, chk, '5.00', 'REFUND', '2026-03-07', { merchant_key: 'SHOP' })
    categorize(db, refund.id, 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE')

    const [start, end] = [d8('2026-03-01'), d8('2026-04-01')]
    expect(expensesBetween(db, start, end)).toBe(m('65.00'))
    expect(expensesBetween(db, start, end, ['NETFLIX'])).toBe(m('55.00'))
    expect(expensesBetween(db, start, end, [], { excludeOneTime: true })).toBe(m('45.00'))
    expect(expensesBetween(db, start, end, ['NETFLIX', 'SHOP'], { excludeOneTime: true })).toBe(m('40.00'))
    expect(incomeBetween(db, start, end)).toBe(m('1007.00'))
    expect(incomeBetween(db, start, end, ['ACME'])).toBe(m('7.00'))
    expect(expensesBetween(db, d8('2026-05-01'), d8('2026-06-01'))).toBe(0)
  })

  it('largest_expense_ids, expense_ids, and expense_amounts skip money in and transfers', () => {
    const db = makeDb()
    const chk = makeAccount(db)
    const a = makeTx(db, chk, '-10.00', 'A', '2026-03-01')
    const b = makeTx(db, chk, '-30.00', 'B', '2026-03-02')
    const c = makeTx(db, chk, '-30.00', 'C', '2026-03-03')
    const d = makeTx(db, chk, '-5.00', 'D', '2026-03-04')
    makeTx(db, chk, '-999.00', 'TRANSFER', '2026-03-05', { is_transfer: true })
    makeTx(db, chk, '50.00', 'PAY', '2026-03-06')
    const refund = makeTx(db, chk, '8.00', 'REFUND', '2026-03-07')
    categorize(db, refund.id, 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE')
    const card = makeTx(db, chk, '-700.00', 'CARD PAYMENT', '2026-03-08')
    categorize(db, card.id, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')
    makeTx(db, chk, '-60.00', 'APRIL', '2026-04-01')

    const [start, end] = [d8('2026-03-01'), d8('2026-04-01')]
    expect(largestExpenseIds(db, start, end)).toEqual([b.id, c.id, a.id, d.id])
    expect(largestExpenseIds(db, start, end, 2)).toEqual([b.id, c.id])
    expect(expenseIds(db, start, end)).toEqual([b.id, c.id, a.id, d.id])
    expect(expenseIds(db, start, end, m('10.00'))).toEqual([b.id, c.id, a.id])
    expect([...expenseAmounts(db, start, end)].sort((x, y) => x - y)).toEqual([m('5.00'), m('10.00'), m('30.00'), m('30.00')])
  })

  it('current_total_balance breaks a same-instant tie by the later snapshot id and is zero without snapshots', () => {
    const db = makeDb()
    expect(currentTotalBalance(db)).toBe(0)
    const chk = makeAccount(db)
    const t = '2026-09-01T00:00:00.000Z'
    snapshot(db, chk.id, '100.00', t)
    snapshot(db, chk.id, '120.00', t)
    expect(currentTotalBalance(db)).toBe(m('120.00'))
  })
})
