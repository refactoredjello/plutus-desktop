import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Envelope } from './diff.ts'
import { ENDPOINTS, NOT_COMPARED, templateFor } from './endpoints.ts'
import type { Json } from './normalize.ts'
import { bridgeSteps } from './sync_steps.ts'
import { type Api, PrepareError, type State, type StepRequest, WRITE_STEPS, runPrepare } from './writes.ts'

const TODAY = '2026-09-30'
const skippedOps = new Set(NOT_COMPARED.map((n) => n.endpoint))

const tx = (id: number, extra: Record<string, Json> = {}): Json => ({
  id,
  account_id: 2,
  posted_on: '2026-09-30',
  amount: '-6.75',
  merchant_key: `MERCHANT ${id}`,
  is_transfer: false,
  note: null,
  one_time: false,
  categorization: { category_id: 60, essentiality: 'discretionary', source: 'llm', confidence: 'high' },
  ...extra,
})

const GETS: Record<string, Json> = {
  '/api/transactions?limit=500': {
    items: [
      tx(1, { merchant_key: null }),
      tx(2, { is_transfer: true }),
      tx(3, { amount: '2850.00' }),
      tx(4, { categorization: { category_id: 60, essentiality: null, source: 'manual', confidence: 'high' } }),
      tx(5, { merchant_key: 'NETFLIX.COM CA' }),
      tx(6, { merchant_key: 'BLUE BOTTLE COFFEE OAKLAND CA', categorization: null }),
      tx(7, { merchant_key: 'SHELL OIL OAKLAND CA' }),
      tx(8, { merchant_key: 'TRADER JOE S OAKLAND CA' }),
    ],
    total: 8,
    limit: 500,
    offset: 0,
  },
  '/api/categories': [
    { id: 60, primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' },
    { id: 61, primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_FAST_FOOD' },
    { id: 63, primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT' },
  ],
  '/api/transactions?needs_review=true&limit=500': { items: [tx(5), tx(9)], total: 2, limit: 500, offset: 0 },
  '/api/reports/month/2026-09': { largest: [tx(11, { amount: '-2100.00' }), tx(12)] },
  '/api/recurring?status=proposed': [
    { id: 2, merchant_key: 'ZELLE TO' },
    { id: 3, merchant_key: 'NETFLIX.COM CA' },
  ],
  '/api/recurring': [
    { id: 2, merchant_key: 'ZELLE TO' },
    { id: 3, merchant_key: 'NETFLIX.COM CA' },
  ],
  '/api/reports/changes?all=true': { items: [{ key: 'S4:category:110:2026-09' }, { key: 'S7:review:1:2' }] },
  '/api/rules': [{ id: 4 }, { id: 9 }],
  '/api/transactions?include_transfers=true&limit=500': {
    items: [tx(1), tx(2, { is_transfer: true }), tx(5, { merchant_key: 'NETFLIX.COM CA' })],
    total: 3,
    limit: 500,
    offset: 0,
  },
}

const WRITES: Record<string, Json> = {
  'POST /api/manual-entries': { id: 31 },
  'POST /api/goals': { id: 41 },
  'POST /api/goals/{goal_id}/suggestions': [{ id: 51 }, { id: 52 }],
  'POST /api/categories': { id: 200 },
  'PATCH /api/suggestions/{suggestion_id}': { id: 51 },
}

function fakeApi(gets: Record<string, Json> = GETS): Api & { calls: string[] } {
  const calls: string[] = []
  let manualEntries = 0
  return {
    calls,
    async send(method: string, path: string, body?: Json): Promise<Envelope> {
      calls.push(`${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`)
      if (method === 'GET') {
        const hit = gets[path]
        return hit === undefined
          ? { status: 404, contentType: 'application/problem+json', body: { status: 404 } }
          : { status: 200, contentType: 'application/json', body: hit }
      }
      const template = templateFor(method, path)
      let response = WRITES[template] ?? null
      if (template === 'POST /api/manual-entries') response = { id: 31 + manualEntries++ }
      return { status: 200, contentType: 'application/json', body: response }
    },
  }
}

async function runAll(api: Api): Promise<{ requests: StepRequest[]; state: State }> {
  const state: State = {}
  const requests: StepRequest[] = []
  for (const step of WRITE_STEPS) {
    const req = await runPrepare(step, api, state, TODAY)
    requests.push(req)
    const res = await api.send(req.method, req.path, req.body)
    step.capture?.(res, state)
  }
  return { requests, state }
}

describe('WRITE_STEPS', () => {
  it('runs the scripted sequence against hand-written data', async () => {
    const { requests, state } = await runAll(fakeApi())
    const byName = Object.fromEntries(WRITE_STEPS.map((s, i) => [s.name, requests[i]]))

    // The first LLM- or rule-categorized outflow with a merchant key, moved to Restaurant.
    expect(byName['recategorize with save-as-rule']).toEqual({
      method: 'PATCH',
      path: '/api/transactions/5',
      body: { category_id: 63, essentiality: 'discretionary', save_as_rule: true, rule_match_type: 'exact' },
    })
    // The first transaction needing review other than the one just recategorized.
    expect(byName['add a note']).toEqual({
      method: 'PATCH',
      path: '/api/transactions/9',
      body: { note: 'Parity: split with a friend' },
    })
    expect(byName['mark one-time']).toEqual({ method: 'PATCH', path: '/api/transactions/11', body: { one_time: true } })
    expect(byName['confirm a recurrence']).toEqual({
      method: 'PATCH',
      path: '/api/recurring/2',
      body: { status: 'confirmed' },
    })
    expect(byName['dismiss a recurrence']).toEqual({
      method: 'PATCH',
      path: '/api/recurring/3',
      body: { status: 'dismissed' },
    })
    // The first outflow whose merchant is not already recurring.
    expect(byName['mark a merchant yearly recurring']).toEqual({
      method: 'POST',
      path: '/api/recurring',
      body: { transaction_id: 4, cadence: 'yearly' },
    })
    expect(byName['create a manual entry']).toEqual({
      method: 'POST',
      path: '/api/manual-entries',
      body: { amount: '-180.00', description: 'Parity car registration', due_date: '2026-10-14', recurrence: 'none' },
    })
    expect(byName['delete a manual entry']).toEqual({ method: 'DELETE', path: '/api/manual-entries/32' })
    expect(byName['create a goal']?.body).toEqual({
      name: 'Parity emergency fund',
      target_amount: '6000.00',
      target_date: '2027-09-30',
    })
    expect(byName['generate suggestions']).toEqual({ method: 'POST', path: '/api/goals/41/suggestions' })
    expect(byName['dismiss a suggestion']).toEqual({
      method: 'PATCH',
      path: '/api/suggestions/51',
      body: { status: 'dismissed' },
    })
    expect(byName['dismiss a change']).toEqual({
      method: 'POST',
      path: '/api/reports/changes/dismiss',
      body: { key: 'S4:category:110:2026-09' },
    })
    expect(byName['hide a category']).toEqual({
      method: 'PATCH',
      path: '/api/categories/200',
      body: { is_hidden: true },
    })
    expect(byName['delete a rule']).toEqual({ method: 'DELETE', path: '/api/rules/4' })
    expect(state.goalId).toBe(41)
  })

  it('covers every write in the contract that is not explicitly skipped', async () => {
    const { requests } = await runAll(fakeApi())
    // The bridge steps resolve to their endpoint (sync_steps.test.ts checks that).
    const bridge = { token: () => 't', setMode: () => {}, setDelay: () => {} }
    const exercised = new Set([
      ...requests.map((r) => templateFor(r.method, r.path)),
      ...bridgeSteps(bridge).map((s) => s.endpoint),
    ])
    const skipped = new Set(NOT_COMPARED.map((n) => n.endpoint))
    const openapi = JSON.parse(
      readFileSync(new URL('../../web/src/api/openapi.json', import.meta.url), 'utf8'),
    ) as { paths: Record<string, Record<string, unknown>> }
    const writes = Object.entries(openapi.paths).flatMap(([path, ops]) =>
      Object.keys(ops)
        .filter((m) => m !== 'get')
        .map((m) => `${m.toUpperCase()} ${path}`),
    )
    expect(writes.filter((w) => !exercised.has(w) && !skipped.has(w))).toEqual([])
  })

  it('includes the eight writes the plan names', () => {
    const names = WRITE_STEPS.map((s) => s.name)
    for (const name of [
      'recategorize with save-as-rule',
      'add a note',
      'mark one-time',
      'confirm a recurrence',
      'create a manual entry',
      'create a goal',
      'generate suggestions',
      'dismiss a change',
    ]) {
      expect(names).toContain(name)
    }
  })

  it('names each step by the template its request resolves to and re-reads GETs', async () => {
    const api = fakeApi()
    const state: State = {}
    for (const step of WRITE_STEPS) {
      const req = await runPrepare(step, api, state, TODAY)
      expect(templateFor(req.method, req.path)).toBe(step.endpoint)
      for (const path of step.reread(state, TODAY)) expect(path.startsWith('/api/')).toBe(true)
      step.capture?.(await api.send(req.method, req.path, req.body), state)
    }
  })

  it('fails preparation with a PrepareError when the app has no usable data', async () => {
    const empty = fakeApi({})
    await expect(runPrepare(WRITE_STEPS[0]!, empty, {}, TODAY)).rejects.toBeInstanceOf(PrepareError)
    await expect(runPrepare(WRITE_STEPS[0]!, empty, {}, TODAY)).rejects.toThrow(
      'GET /api/transactions?limit=500 answered 404',
    )
  })

  it('fails preparation when a step needs state an earlier step did not capture', async () => {
    const step = WRITE_STEPS.find((s) => s.name === 'generate suggestions')!
    await expect(runPrepare(step, fakeApi(), {}, TODAY)).rejects.toThrow('goalId')
  })
})

describe('error paths and edge cases', () => {
  async function requestsByName(): Promise<Record<string, StepRequest | undefined>> {
    const { requests } = await runAll(fakeApi())
    return Object.fromEntries(WRITE_STEPS.map((s, i) => [s.name, requests[i]]))
  }

  it('sends every write with a path parameter to a missing id too', async () => {
    const { requests } = await runAll(fakeApi())
    const templated = ENDPOINTS.filter((e) => !e.startsWith('GET ') && e.includes('{') && !skippedOps.has(e))
    const missing = new Set(
      requests.filter((r) => r.path.split('/').includes('999999')).map((r) => templateFor(r.method, r.path)),
    )
    expect(templated.filter((e) => !missing.has(e))).toEqual([])
  })

  it('sends an invalid body to every write that takes one', async () => {
    const { requests } = await runAll(fakeApi())
    const names = WRITE_STEPS.map((s) => s.name)
    for (const name of [
      'reject an invalid goal body',
      'reject an invalid transaction update',
      'reject a bad cadence',
      'reject an invalid recurrence update',
      'reject an invalid manual entry',
      'reject an invalid suggestion status',
      'reject an invalid category',
      'reject an empty change key',
    ]) {
      expect(names).toContain(name)
    }
    expect(requests.some((r) => r.method === 'PATCH' && r.body === undefined)).toBe(true)
    expect(requests.some((r) => r.method === 'POST' && r.path === '/api/goals' && r.body === undefined)).toBe(true)
  })

  it('picks targets for the transaction edge cases from the app\'s own data', async () => {
    const byName = await requestsByName()
    expect(byName['recategorize with a contains rule']).toEqual({
      method: 'PATCH',
      path: '/api/transactions/7',
      body: { category_id: 61, essentiality: 'flexible', save_as_rule: true, rule_match_type: 'contains' },
    })
    expect(byName['recategorize with a prefix rule']?.path).toBe('/api/transactions/8')
    expect(byName['recategorize with a prefix rule']?.body).toMatchObject({ rule_match_type: 'prefix' })
    expect(byName['clear a note and essentiality']).toEqual({
      method: 'PATCH',
      path: '/api/transactions/9',
      body: { note: '', essentiality: null },
    })
    expect(byName['add a note with accents']).toEqual({
      method: 'PATCH',
      path: '/api/transactions/1',
      body: { note: 'Caf\u00e9 \u00e9t\u00e9 \u00c9T\u00c9 (parity)' },
    })
    expect(byName['recategorize to an unknown category']?.body).toEqual({ category_id: 999999 })
    expect(byName['edit a note with save_as_rule false']).toEqual({
      method: 'PATCH',
      path: '/api/transactions/4',
      body: { note: 'Parity default flag', save_as_rule: false },
    })
    expect(byName['update a transaction with no body']).toEqual({ method: 'PATCH', path: '/api/transactions/9' })
    expect(byName['update a transaction with an empty body']?.body).toEqual({})
  })

  it('picks targets for the recurring edge cases', async () => {
    const byName = await requestsByName()
    expect(byName['mark a missing transaction recurring']?.body).toEqual({ transaction_id: 999999, cadence: 'monthly' })
    expect(byName['mark a transfer recurring']?.body).toEqual({ transaction_id: 2, cadence: 'monthly' })
    expect(byName['re-mark a dismissed recurrence']?.body).toEqual({ transaction_id: 5, cadence: 'monthly' })
    expect(byName['change a recurrence cadence and amount']).toEqual({
      method: 'PATCH',
      path: '/api/recurring/2',
      body: { cadence: 'weekly', amount: '-21.99', essentiality: null },
    })
  })

  it('sends money as numbers and edge-case strings', async () => {
    const byName = await requestsByName()
    expect(byName['create a manual entry from a number']?.body).toEqual({
      amount: -42.5,
      description: 'Parity weekly lunch',
      category_id: 63,
      due_date: '2026-10-02',
      recurrence: 'weekly',
    })
    expect(byName['create a manual entry with a sub-cent amount']?.body).toMatchObject({ amount: '12.345' })
    expect(byName['create a manual entry with a negative half cent']?.body).toMatchObject({ amount: '-0.005' })
    expect(byName['create a manual entry with an exponent']?.body).toMatchObject({ amount: '1e2' })
    expect(byName['reject a NaN manual entry amount']?.body).toMatchObject({ amount: 'NaN' })
    expect(byName['create a goal from a number']?.body).toEqual({
      name: 'Parity trip',
      target_amount: 2500,
      target_date: '2027-04-18',
    })
    expect(byName['mark a manual entry fulfilled']?.body).toEqual({ fulfilled_transaction_id: 1 })
  })

  it('repeats the category create for the conflict and renames seeded and custom categories', async () => {
    const byName = await requestsByName()
    expect(byName['create a duplicate category']?.body).toEqual(byName['create a category']?.body)
    expect(byName['rename a category to spaces']).toEqual({
      method: 'PATCH',
      path: '/api/categories/200',
      body: { label: '   ' },
    })
    expect(byName['rename a seeded category']?.path).toBe('/api/categories/63')
    expect(byName['keep a suggestion']).toEqual({ method: 'PATCH', path: '/api/suggestions/51', body: { status: 'kept' } })
    expect(byName['use a method the endpoint lacks']?.method).toBe('PUT')
  })
})
