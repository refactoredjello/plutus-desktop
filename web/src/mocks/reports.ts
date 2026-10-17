import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'
import { addMonths, isoDate, monthEnd, monthKey, parseDate } from '@/lib/dates'
import { accounts } from './accounts'

type Monthly = Schemas['MonthlySummary']

const cents = (n: number) => n.toFixed(2)

// Oldest first, 12 months ending with the current (partial) month.
const incomes = [6300, 6300, 6450, 6300, 6300, 7100, 6300, 6300, 6450, 6300, 6300, 6300]
const expenseSeed = [4980, 5210, 5640, 4875, 5320, 6120, 5105, 5480, 5390, 5070, 5260, 5500]
const split = [0.52, 0.28, 0.2] // essential / flexible / discretionary

/** Full-month figures for the month `back` months before now (0 = current month, scaled to date so far). */
export function monthlySummaries(now = new Date()): Monthly[] {
  const current = monthKey(now)
  const progress = now.getDate() / Number(monthEnd(current).slice(8))
  return incomes.map((inc, i) => {
    const back = incomes.length - 1 - i
    const factor = back === 0 ? progress : 1
    const income = Math.round(inc * (back === 0 ? 0.5 : 1) * 100) / 100
    const expenses = Math.round(expenseSeed[i]! * factor * 100) / 100
    const uncategorized = Math.round(expenses * 0.03 * 100) / 100
    const rest = expenses - uncategorized
    const essential = Math.round(rest * split[0]! * 100) / 100
    const flexible = Math.round(rest * split[1]! * 100) / 100
    return {
      month: addMonths(current, -back),
      income: cents(income),
      expenses: cents(expenses),
      net: cents(income - expenses),
      essential: cents(essential),
      flexible: cents(flexible),
      discretionary: cents(expenses - uncategorized - essential - flexible),
      uncategorized: cents(uncategorized),
    }
  })
}

type Bucket = Schemas['Essentiality'] | 'unset'

// [category id (see categories mock), label, primary, share of the month's expenses, transactions, essentiality bucket]
const categoryShares: [number | null, string, string | null, number, number, Bucket][] = [
  [3, 'Rent', 'RENT_AND_UTILITIES', 0.38, 1, 'essential'],
  [7, 'Groceries', 'FOOD_AND_DRINK', 0.14, 14, 'essential'],
  [8, 'Restaurant', 'FOOD_AND_DRINK', 0.08, 11, 'flexible'],
  [12, 'Gas', 'TRANSPORTATION', 0.06, 6, 'essential'],
  [4, 'Gas and electricity', 'RENT_AND_UTILITIES', 0.05, 2, 'essential'],
  [14, 'Online marketplaces', 'GENERAL_MERCHANDISE', 0.05, 9, 'flexible'],
  [10, 'TV and movies', 'ENTERTAINMENT', 0.04, 4, 'discretionary'],
  [6, 'Coffee', 'FOOD_AND_DRINK', 0.035, 18, 'discretionary'],
  [16, 'Gyms and fitness centers', 'PERSONAL_CARE', 0.03, 1, 'unset'],
  [15, 'Pharmacies and supplements', 'MEDICAL', 0.025, 3, 'essential'],
  [null, 'Uncategorized', null, 0.03, 5, 'unset'],
]

/** Category totals for a month; with `essentiality`, only the categories in that bucket (`unset` includes Uncategorized). */
export function categoryTotals(
  month: string,
  essentiality?: Bucket | null,
  summaries = monthlySummaries(),
): Schemas['CategoryTotal'][] {
  const total = Number(summaries.find((s) => s.month === month)?.expenses ?? 0)
  if (total === 0) return []
  const all = categoryShares.map(([category_id, label, primary, share, count, bucket]) => ({
    category_id, label, primary, count, bucket, total: Math.round(total * share * 100) / 100,
  }))
  // Put rounding drift on the largest row so the rows sum exactly to the month's expenses.
  all[0]!.total = Math.round((all[0]!.total + total - all.reduce((s, r) => s + r.total, 0)) * 100) / 100
  return all
    .filter((r) => !essentiality || r.bucket === essentiality)
    .map(({ bucket: _bucket, ...r }) => ({ ...r, total: cents(r.total) }))
}

/** Daily balances ending at today's account balances; credit accounts are negative. */
export function balanceSeries(start: string, end: string): Schemas['AccountBalanceSeries'][] {
  const days: string[] = []
  for (let d = parseDate(start); isoDate(d) <= end; d.setDate(d.getDate() + 1)) days.push(isoDate(d))
  const endDate = parseDate(end)
  return accounts.map((a) => ({
    account_id: a.id,
    name: a.name,
    points: days.map((on) => {
      const ago = Math.round((endDate.getTime() - parseDate(on).getTime()) / 86_400_000)
      const wobble = a.type === 'savings' ? -ago * 12 : Math.sin(ago / 4 + a.id) * 380 + ago * (a.type === 'credit' ? 2 : -4)
      return { on, balance: cents(Number(a.balance) + wobble) }
    }),
  }))
}

export const reportHandlers = [
  http.get('/api/reports/monthly', ({ request }) => {
    const months = Number(new URL(request.url).searchParams.get('months') ?? 12)
    return HttpResponse.json<Monthly[]>(monthlySummaries().slice(-months))
  }),
  http.get('/api/reports/by-category', ({ request }) => {
    const p = new URL(request.url).searchParams
    const month = p.get('month') ?? monthKey(new Date())
    return HttpResponse.json<Schemas['CategoryTotal'][]>(categoryTotals(month, p.get('essentiality') as Bucket | null))
  }),
  http.get('/api/reports/balances', ({ request }) => {
    const p = new URL(request.url).searchParams
    const today = isoDate(new Date())
    const end = p.get('end') ?? today
    const start = p.get('start') ?? isoDate(new Date(parseDate(end).getTime() - 89 * 86_400_000))
    return HttpResponse.json<Schemas['AccountBalanceSeries'][]>(balanceSeries(start, end))
  }),
]
