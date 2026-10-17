import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'
import { monthEnd, monthKey } from '@/lib/dates'
import { categoryTotals, monthlySummaries } from './reports'

type Detail = Schemas['MonthDetail']

const cents = (n: number) => n.toFixed(2)
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length

// How each category's average relates to this month (average = total / factor), in categoryTotals order.
// 1.0 and 1.02 land inside the "about the same" band; 0 means the category had no spending before.
const factors = [1.0, 0.8, 1.3, 1.02, 1.0, 0.7, 1.5, 0, 1.0, 1.2, 1.0]

const largestSeed: [string, string, string, number][] = [
  ['Landlord LLC', 'ACH WITHDRAWAL LANDLORD LLC RENT', '-2100.00', 3],
  ['Whole Foods', 'WHOLEFDS MKT 10234 AUSTIN TX', '-184.12', 7],
  ['Amazon', 'AMZN Mktp US*2K4LM0 AMZN.COM/BILL WA', '-137.21', 14],
  ['Shell', 'SHELL OIL 57444 AUSTIN TX', '-96.30', 12],
  ['Chipotle', 'CHIPOTLE 2093 AUSTIN TX', '-63.85', 8],
]

export function monthDetail(month: string, now = new Date()): Detail {
  const current = monthKey(now)
  const summaries = monthlySummaries(now)
  const s = summaries.find((x) => x.month === month)
  const prior = summaries.filter((x) => x.month < month && (Number(x.income) !== 0 || Number(x.expenses) !== 0)).slice(-3)
  const n = prior.length
  const complete = month < current
  const income = Number(s?.income ?? 0)
  const expenses = Number(s?.expenses ?? 0)
  const mean = (f: (x: Schemas['MonthlySummary']) => number) => (n === 0 ? null : cents(avg(prior.map(f))))
  const net = income - expenses
  const incomeAvg = n === 0 ? null : avg(prior.map((x) => Number(x.income)))
  const netAvg = n === 0 ? null : avg(prior.map((x) => Number(x.net)))
  const buckets = ['essential', 'flexible', 'discretionary', 'unset'] as const
  const value = (b: (typeof buckets)[number]) => Number(b === 'unset' ? s?.uncategorized : s?.[b]) || 0
  const cats = categoryTotals(month, null, summaries)
  const count = cats.reduce((sum, c) => sum + c.count, 0)
  return {
    month,
    is_complete: complete,
    days_elapsed: complete ? Number(monthEnd(month).slice(8)) : now.getDate(),
    days_in_month: Number(monthEnd(month).slice(8)),
    average_months: n,
    income: cents(income),
    income_average: incomeAvg === null ? null : cents(incomeAvg),
    expenses: cents(expenses),
    expenses_average: mean((x) => Number(x.expenses)),
    net: cents(net),
    net_average: netAvg === null ? null : cents(netAvg),
    savings_rate: income ? net / income : null,
    savings_rate_average: incomeAvg && netAvg !== null ? netAvg / incomeAvg : null,
    essentiality: buckets.map((b) => ({
      essentiality: b,
      total: cents(value(b)),
      share: expenses ? value(b) / expenses : 0,
    })),
    categories: cats.map((c, i) => ({
      category_id: c.category_id,
      label: c.label,
      primary: c.primary,
      total: c.total,
      count: c.count,
      average: n === 0 ? null : cents(factors[i] ? Number(c.total) / factors[i]! : 0),
    })),
    largest: expenses
      ? largestSeed.map(([payee, raw, amount, category_id], i) => ({
          id: 9000 + i,
          account_id: 1,
          posted_on: `${month}-${String(2 + i * 3).padStart(2, '0')}`,
          amount,
          raw_description: raw,
          payee,
          pending: false,
          merchant_key: payee.toLowerCase().replace(/\W+/g, '-'),
          note: null,
          one_time: false,
          is_transfer: false,
          categorization: { category_id, essentiality: 'essential', source: 'rule', confidence: 'high' },
        }))
      : [],
    transaction_count: count,
    review_count: count ? 3 : 0,
  }
}

export const monthHandlers = [
  http.get('/api/reports/month/:month', ({ params }) => {
    const month = String(params.month)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return HttpResponse.json({ title: 'Unprocessable Entity', status: 422, detail: 'Invalid month' }, { status: 422 })
    }
    if (month > monthKey(new Date())) {
      return HttpResponse.json(
        { title: 'Bad Request', status: 400, detail: `${month} is in the future` },
        { status: 400 },
      )
    }
    return HttpResponse.json<Detail>(monthDetail(month))
  }),
]

