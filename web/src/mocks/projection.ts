import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'
import { addMonths, isoDate, monthKey } from '@/lib/dates'
import { accounts } from './accounts'

export function projection(months = 3, now = new Date()): Schemas['ProjectionRead'] {
  const current = accounts.reduce((s, a) => s + Number(a.balance), 0)
  let balance = current
  const out: Schemas['ProjectedMonth'][] = []
  for (let i = 0; i < months; i++) {
    const partial = i === 0
    const recurringIncome = partial ? 3150 : 6300
    const recurringExpenses = partial ? 2400 : 3150
    const variable = partial ? 640 : 1980
    const end = balance + recurringIncome - recurringExpenses - variable
    out.push({
      month: addMonths(monthKey(now), i),
      starting_balance: balance.toFixed(2),
      recurring_income: recurringIncome.toFixed(2),
      recurring_expenses: recurringExpenses.toFixed(2),
      manual_income: '0.00',
      manual_expenses: partial ? '0.00' : '120.00',
      variable_spending: variable.toFixed(2),
      variable_income: '0.00',
      projected_end_balance: end.toFixed(2),
    })
    balance = end
  }
  return {
    as_of: isoDate(now),
    current_balance: current.toFixed(2),
    months: out,
    assumptions: [
      'Recurring income and bills repeat on their usual schedule.',
      'Variable spending follows your average over the last 3 months.',
      'Planned one-off entries are included in the month they are dated.',
    ],
  }
}

export const projectionHandlers = [
  http.get('/api/projection', ({ request }) => {
    const months = Number(new URL(request.url).searchParams.get('months') ?? 3)
    return HttpResponse.json<Schemas['ProjectionRead']>(projection(months))
  }),
]
