/** Manual entries (planned income and expenses). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { categoryId, makeAccount, makeTx } from './factories.js'
import { makeApp } from './setup.js'

type Body = Record<string, unknown>
type Entry = { id: number; [key: string]: unknown }

let ctx: ReturnType<typeof makeApp>

beforeEach(() => {
  ctx = makeApp()
})

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await ctx.app.request(path, init)
  const text = await res.text()
  return { status: res.status, json: text === '' ? null : JSON.parse(text) }
}

const post = (body: Body) => call('POST', '/api/manual-entries', body)
const patch = (url: string, body: Body) => call('PATCH', url, body)
const list = async () => (await call('GET', '/api/manual-entries')).json as Entry[]

function body(over: Body = {}): Body {
  return { amount: '-120.50', description: 'Car insurance', due_date: '2026-11-01', ...over }
}

describe('manual entries', () => {
  it('creates and lists sorted by due date', async () => {
    await post(body({ description: 'Later', due_date: '2026-12-01' }))
    const r = await post(body({ description: 'Sooner' }))
    expect(r.status).toBe(201)
    expect((r.json as Entry).amount).toBe('-120.50')
    expect((r.json as Entry).recurrence).toBe('none')
    expect((await list()).map((e) => e.description)).toEqual(['Sooner', 'Later'])
  })

  it('patches only sent fields', async () => {
    const cat = categoryId(ctx.db, 'FOOD_AND_DRINK_COFFEE')
    const created = (await post(body({ category_id: cat }))).json as Entry
    let r = await patch(`/api/manual-entries/${created.id}`, { description: 'Insurance' })
    expect(r.status).toBe(200)
    expect((r.json as Entry).description).toBe('Insurance')
    expect((r.json as Entry).category_id).toBe(cat)
    expect((r.json as Entry).amount).toBe('-120.50')
    r = await patch(`/api/manual-entries/${created.id}`, { category_id: null })
    expect((r.json as Entry).category_id).toBeNull()
  })

  it('rejects null for a required field', async () => {
    const created = (await post(body())).json as Entry
    const r = await patch(`/api/manual-entries/${created.id}`, { amount: null })
    expect(r.status).toBe(400)
  })

  it('deletes', async () => {
    const created = (await post(body())).json as Entry
    expect((await call('DELETE', `/api/manual-entries/${created.id}`)).status).toBe(204)
    expect(await list()).toEqual([])
  })

  it('validates end_date', async () => {
    let r = await post(body({ recurrence: 'monthly', end_date: '2026-10-01' }))
    expect(r.status).toBe(400)
    r = await post(body({ end_date: '2026-12-01' }))
    expect(r.status).toBe(400)
    const ok = await post(body({ recurrence: 'monthly', end_date: '2026-11-01' }))
    expect(ok.status).toBe(201)
  })

  it('validates a patch against the merged state', async () => {
    const created = (await post(body({ recurrence: 'monthly', end_date: '2027-01-01' }))).json as Entry
    const url = `/api/manual-entries/${created.id}`
    expect((await patch(url, { recurrence: 'none' })).status).toBe(400)
    expect((await patch(url, { due_date: '2027-02-01' })).status).toBe(400)
    expect((await patch(url, { recurrence: 'none', end_date: null })).status).toBe(200)
  })

  it('rejects unknown references', async () => {
    expect((await post(body({ category_id: 999999 }))).status).toBe(400)
    const created = (await post(body())).json as Entry
    const url = `/api/manual-entries/${created.id}`
    expect((await patch(url, { fulfilled_transaction_id: 999999 })).status).toBe(400)
    const tx = makeTx(ctx.db, makeAccount(ctx.db), '-120.50', undefined, '2026-11-01')
    const r = await patch(url, { fulfilled_transaction_id: tx.id })
    expect(r.status).toBe(200)
    expect((r.json as Entry).fulfilled_transaction_id).toBe(tx.id)
  })

  it('answers 404 for a missing id', async () => {
    expect((await patch('/api/manual-entries/999999', { description: 'x' })).status).toBe(404)
    expect((await call('DELETE', '/api/manual-entries/999999')).status).toBe(404)
  })
})

describe('upcoming planned totals', () => {
  const upcoming = async (query = '') => (await call('GET', `/api/manual-entries/upcoming${query}`)).json as Body

  beforeEach(() => {
    vi.stubEnv('PLUTUS_TODAY', '2026-11-10')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is zero with nothing planned', async () => {
    expect(await upcoming()).toEqual({ from_date: '2026-11-10', to_date: '2026-12-09', due: '0.00', expected: '0.00' })
  })

  it('sums open entries due in the next 30 days, today included', async () => {
    await post(body({ amount: '-100.00', due_date: '2026-11-10' }))
    await post(body({ amount: '-50.25', due_date: '2026-12-09' }))
    await post(body({ amount: '500.00', due_date: '2026-11-20' }))
    await post(body({ amount: '-999.00', due_date: '2026-12-10' })) // past the window
    await post(body({ amount: '-999.00', due_date: '2026-11-09' })) // overdue, not upcoming
    expect(await upcoming()).toMatchObject({ due: '150.25', expected: '500.00' })
  })

  it('counts every occurrence of a repeating entry until its end date', async () => {
    // Weekly from Nov 3: Nov 10, 17, 24, Dec 1, 8 are in the window.
    await post(body({ amount: '-10.00', due_date: '2026-11-03', recurrence: 'weekly' }))
    // Semimonthly from Oct 15 pairs with month end: Nov 15, Nov 30 (Dec 15 is past the window).
    await post(body({ amount: '1000.00', due_date: '2026-10-15', recurrence: 'semimonthly' }))
    // Monthly from Oct 12, ending Nov 30: only Nov 12.
    await post(body({ amount: '-7.00', due_date: '2026-10-12', recurrence: 'monthly', end_date: '2026-11-30' }))
    expect(await upcoming()).toMatchObject({ due: '57.00', expected: '2000.00' })
  })

  it('leaves fulfilled entries out', async () => {
    const account = makeAccount(ctx.db)
    const tx = makeTx(ctx.db, account, '-100.00', undefined, '2026-11-12')
    const created = (await post(body({ amount: '-100.00', due_date: '2026-11-12' }))).json as Entry
    await patch(`/api/manual-entries/${created.id}`, { fulfilled_transaction_id: tx.id })
    expect(await upcoming()).toMatchObject({ due: '0.00', expected: '0.00' })
  })

  it('takes a window length', async () => {
    await post(body({ amount: '-100.00', due_date: '2026-11-20' }))
    expect(await upcoming('?days=7')).toMatchObject({ to_date: '2026-11-16', due: '0.00' })
  })
})
