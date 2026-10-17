import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'
import { transactions } from './transactions'

type Charge = Schemas['RecurringChargeRead']

const initial = (): Charge[] => [
  { id: 1, merchant_key: 'NETFLIX.COM CA', account_id: 3, amount: '-15.49', cadence: 'monthly', next_expected_date: '2026-10-15', last_seen_on: '2026-09-15', status: 'confirmed', essentiality: 'discretionary', annual_cost: '-185.88' },
  { id: 2, merchant_key: 'LANDLORD LLC', account_id: 1, amount: '-2100.00', cadence: 'monthly', next_expected_date: '2026-11-01', last_seen_on: '2026-10-01', status: 'confirmed', essentiality: 'essential', annual_cost: '-25200.00' },
  { id: 3, merchant_key: 'GYM CO', account_id: 3, amount: '-40.00', cadence: 'monthly', next_expected_date: '2026-10-20', last_seen_on: '2026-09-20', status: 'confirmed', essentiality: 'flexible', annual_cost: '-480.00' },
  { id: 4, merchant_key: 'ACME CORP PAYROLL', account_id: 1, amount: '3150.00', cadence: 'biweekly', next_expected_date: '2026-10-09', last_seen_on: '2026-09-25', status: 'confirmed', essentiality: null, annual_cost: '81900.00' },
  { id: 5, merchant_key: 'SPOTIFY USA', account_id: 3, amount: '-11.99', cadence: 'monthly', next_expected_date: '2026-10-12', last_seen_on: '2026-09-12', status: 'proposed', essentiality: null, annual_cost: '-143.88' },
  { id: 6, merchant_key: 'OLD MAGAZINE', account_id: 3, amount: '-9.00', cadence: 'monthly', next_expected_date: '2026-10-30', last_seen_on: '2026-09-30', status: 'dismissed', essentiality: null, annual_cost: '-108.00' },
]

export let recurring: Charge[] = initial()

export function resetRecurring() {
  recurring = initial()
}

const ANNUAL = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, yearly: 1 } as const

export const recurringHandlers = [
  http.get('/api/recurring', ({ request }) => {
    const status = new URL(request.url).searchParams.get('status')
    return HttpResponse.json<Charge[]>(
      recurring.filter((c) => (status ? c.status === status : c.status !== 'dismissed')),
    )
  }),
  http.patch('/api/recurring/:id', async ({ params, request }) => {
    const body = (await request.json()) as Schemas['RecurringChargeUpdate']
    const charge = recurring.find((c) => c.id === Number(params.id))
    if (!charge) return HttpResponse.json({ title: 'Not Found', status: 404, detail: 'Recurring charge not found' }, { status: 404 })
    if (body.status != null) charge.status = body.status
    if (body.essentiality != null) charge.essentiality = body.essentiality
    if (body.cadence != null) charge.cadence = body.cadence
    if (body.amount != null) charge.amount = String(body.amount)
    charge.annual_cost = (Number(charge.amount) * ANNUAL[charge.cadence]).toFixed(2)
    return HttpResponse.json<Charge>(charge)
  }),
  http.post('/api/recurring', async ({ request }) => {
    const body = (await request.json()) as Schemas['RecurringChargeCreate']
    const txn = transactions.find((t) => t.id === body.transaction_id)
    const problem = (status: number, title: string, detail: string) =>
      HttpResponse.json({ title, status, detail }, { status })
    if (!txn) return problem(404, 'Not Found', 'Transaction not found')
    if (txn.is_transfer) return problem(400, 'Bad Request', 'Transfers cannot be recurring charges')
    if (!txn.merchant_key) return problem(400, 'Bad Request', 'This transaction has no merchant yet')
    const key = txn.merchant_key.toUpperCase()
    let charge = recurring.find((c) => c.merchant_key === key && c.account_id === txn.account_id)
    if (!charge) {
      charge = {
        id: Math.max(0, ...recurring.map((c) => c.id)) + 1,
        merchant_key: key,
        account_id: txn.account_id,
        amount: txn.amount,
        cadence: body.cadence,
        next_expected_date: '2026-11-01',
        last_seen_on: txn.posted_on,
        status: 'confirmed',
        essentiality: txn.categorization?.essentiality ?? null,
        annual_cost: '0.00',
      }
      recurring.push(charge)
    }
    charge.status = 'confirmed'
    charge.cadence = body.cadence
    charge.annual_cost = (Number(charge.amount) * ANNUAL[charge.cadence]).toFixed(2)
    return HttpResponse.json<Charge>(charge, { status: 201 })
  }),
]
