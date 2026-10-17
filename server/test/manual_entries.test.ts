/** Ports api/tests/test_manual_entries.py. */

import { beforeEach, describe, expect, it } from 'vitest'
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
