import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'
import { categories } from './categories'

type Txn = Schemas['TransactionRead']
type Confidence = Schemas['Confidence']

const byDetailed = (d: string) => categories.find((c) => c.detailed === d)?.id ?? 1

// [merchant, raw description, amount, category, essentiality, confidence | null (uncategorized), account]
const merchants: [string, string, string, string, Schemas['Essentiality'], Confidence | null, number][] = [
  ['Blue Bottle Coffee', 'BLUE BOTTLE COFFEE #112 SF CA', '-5.75', 'FOOD_AND_DRINK_COFFEE', 'discretionary', 'very_high', 3],
  ['Whole Foods', 'WHOLEFDS MKT 10234 AUSTIN TX', '-84.12', 'FOOD_AND_DRINK_GROCERIES', 'essential', 'high', 3],
  ['Netflix', 'NETFLIX.COM 866-579-7172 CA', '-15.49', 'ENTERTAINMENT_TV_AND_MOVIES', 'discretionary', 'very_high', 3],
  ['Landlord LLC', 'ACH WITHDRAWAL LANDLORD LLC RENT', '-2100.00', 'RENT_AND_UTILITIES_RENT', 'essential', 'high', 1],
  ['Acme Corp', 'ACME CORP PAYROLL DIRECT DEP', '3150.00', 'INCOME_SALARY', 'essential', 'very_high', 1],
  ['Shell', 'SHELL OIL 57444 AUSTIN TX', '-46.30', 'TRANSPORTATION_GAS', 'essential', 'medium', 3],
  ['Spotify', 'SPOTIFY USA 877-7781161', '-11.99', 'ENTERTAINMENT_MUSIC_AND_AUDIO', 'discretionary', 'high', 3],
  ['Amazon', 'AMZN Mktp US*2K4LM0 AMZN.COM/BILL WA', '-37.21', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', 'flexible', 'low', 3],
  ['Chipotle', 'CHIPOTLE 2093 AUSTIN TX', '-13.85', 'FOOD_AND_DRINK_FAST_FOOD', 'flexible', 'high', 3],
  ['Unknown merchant', 'POS DEBIT 88213 SQ *PAYMENT', '-22.00', '', 'flexible', null, 1],
]

function build(): Txn[] {
  const out: Txn[] = []
  for (let i = 0; i < 120; i++) {
    const [name, raw, amount, cat, ess, conf, acct] = merchants[i % merchants.length]!
    const day = new Date(Date.UTC(2026, 9, 2) - i * 86_400_000 * 0.8)
    out.push({
      id: 1000 - i,
      account_id: acct,
      posted_on: day.toISOString().slice(0, 10),
      amount,
      raw_description: raw,
      payee: conf === null ? null : name,
      memo: i === 0 ? 'Card ending 4242' : null,
      pending: i < 2,
      merchant_key: conf === null ? null : name.toLowerCase().replace(/\W+/g, '-'),
      note: null,
      one_time: false,
      is_transfer: false,
      review_reason: null,
      categorization:
        conf === null
          ? null
          : { category_id: byDetailed(cat), essentiality: ess, source: conf === 'low' ? 'llm' : 'rule', confidence: conf },
    })
  }
  out.push({
    id: 500, account_id: 1, posted_on: '2026-09-28', amount: '-500.00', raw_description: 'TRANSFER TO SAVINGS',
    payee: null, memo: null, pending: false, merchant_key: null, note: null, one_time: false, is_transfer: true, review_reason: null,
    categorization: { category_id: byDetailed('TRANSFER_OUT_ACCOUNT_TRANSFER'), essentiality: null, source: 'rule', confidence: 'very_high' },
  })
  // A pending charge the bank stopped returning: past the sync's reach, so it needs review.
  out[1]!.review_reason = 'Pending for over 44 days'
  return out
}

export let transactions: Txn[] = build()

export function resetTransactions() {
  transactions = build()
}

export const needsReview = (t: Txn) =>
  !t.categorization || t.categorization.confidence === 'low' || t.categorization.confidence === 'unknown' || t.review_reason !== null

const notFound = () => HttpResponse.json({ title: 'Not Found', status: 404, detail: 'Transaction not found' }, { status: 404 })
const notPending = (id: number) =>
  HttpResponse.json({ title: 'Conflict', status: 409, detail: `Transaction ${id} is not pending.` }, { status: 409 })

export const transactionHandlers = [
  http.get('/api/transactions', ({ request }) => {
    const p = new URL(request.url).searchParams
    const q = p.get('q')?.toLowerCase()
    const accountIds = p.getAll('account_id').map(Number)
    const categoryIds = p.getAll('category_id').map(Number)
    const limit = Number(p.get('limit') ?? 50)
    const offset = Number(p.get('offset') ?? 0)
    const filtered = transactions
      .filter((t) => p.get('include_transfers') === 'true' || !t.is_transfer)
      .filter((t) => !q || `${t.payee ?? ''} ${t.raw_description} ${t.note ?? ''}`.toLowerCase().includes(q))
      .filter((t) => !p.get('start') || t.posted_on >= p.get('start')!)
      .filter((t) => !p.get('end') || t.posted_on <= p.get('end')!)
      .filter((t) => !accountIds.length || accountIds.includes(t.account_id))
      .filter((t) => !categoryIds.length || (t.categorization && categoryIds.includes(t.categorization.category_id)))
      .filter((t) => {
        const ess = p.get('essentiality')
        if (!ess) return true
        return ess === 'unset' ? !t.categorization?.essentiality : t.categorization?.essentiality === ess
      })
      .filter((t) => p.get('uncategorized') !== 'true' || !t.categorization)
      .filter((t) => p.get('needs_review') !== 'true' || needsReview(t))
    return HttpResponse.json<Schemas['Page_TransactionRead_']>({
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
    })
  }),
  http.patch('/api/transactions/:id', async ({ params, request }) => {
    const body = (await request.json()) as Schemas['TransactionUpdate']
    const txn = transactions.find((t) => t.id === Number(params.id))
    if (!txn) return HttpResponse.json({ title: 'Not Found', status: 404, detail: 'Transaction not found' }, { status: 404 })
    if (body.note !== undefined) txn.note = body.note?.trim() || null
    if (body.one_time != null) txn.one_time = body.one_time
    const cur = txn.categorization
    const categoryId = body.category_id ?? cur?.category_id
    if (categoryId != null && (body.category_id != null || body.essentiality != null)) {
      txn.categorization = {
        category_id: categoryId,
        essentiality: body.essentiality ?? cur?.essentiality ?? null,
        source: 'manual',
        confidence: 'very_high',
      }
    }
    return HttpResponse.json<Txn>(txn)
  }),
  http.post('/api/transactions/:id/unpair', ({ params }) => {
    const txn = transactions.find((t) => t.id === Number(params.id))
    if (!txn) return HttpResponse.json({ title: 'Not Found', status: 404, detail: 'Transaction not found' }, { status: 404 })
    if (!txn.is_transfer) {
      return HttpResponse.json({ title: 'Bad Request', status: 400, detail: `Transaction ${txn.id} is not a transfer` }, { status: 400 })
    }
    txn.is_transfer = false
    if (txn.categorization?.category_id === byDetailed('TRANSFER_OUT_ACCOUNT_TRANSFER') && txn.categorization.source === 'rule') {
      txn.categorization = null
    }
    return HttpResponse.json<Txn>(txn)
  }),
  http.post('/api/transactions/:id/mark-posted', ({ params }) => {
    const txn = transactions.find((t) => t.id === Number(params.id))
    if (!txn) return notFound()
    if (!txn.pending) return notPending(txn.id)
    txn.pending = false
    txn.review_reason = null
    return HttpResponse.json<Txn>(txn)
  }),
  http.delete('/api/transactions/:id', ({ params }) => {
    const txn = transactions.find((t) => t.id === Number(params.id))
    if (!txn) return notFound()
    if (!txn.pending) return notPending(txn.id)
    transactions = transactions.filter((t) => t !== txn)
    return new HttpResponse(null, { status: 204 })
  }),
]
