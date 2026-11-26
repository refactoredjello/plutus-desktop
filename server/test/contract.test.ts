/**
 * Guards on the API contract: every route is declared and tagged, the committed spec is
 * current, the config contract, and request parsing. The models-versus-migrations guard lives
 * in db.test.ts.
 */

import { readFileSync } from 'node:fs'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { renderOpenApi } from '../scripts/export-openapi.js'
import { MoneyInput, PositiveMoneyInput } from '../src/schemas/common.js'
import { makeApp } from './setup.js'

type Schema = { [key: string]: unknown }

interface Parameter {
  in: string
  name: string
  required: boolean
  schema: Schema
}

interface Operation {
  operationId: string
  summary?: string
  description?: string
  tags?: string[]
  parameters?: Parameter[]
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema }> }
  responses: Record<string, { description: string; content?: Record<string, { schema: Schema }> }>
}

interface Spec {
  paths: Record<string, Record<string, Operation>>
  components: { schemas: Record<string, Schema> }
}

const SPEC_PATH = new URL('../../web/src/api/openapi.json', import.meta.url)
const SERVER: Spec = JSON.parse(renderOpenApi())

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']

function operations(spec: Spec): Array<[string, Operation]> {
  return Object.entries(spec.paths).flatMap(([path, ops]) =>
    Object.entries(ops)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, op]): [string, Operation] => [`${method.toUpperCase()} ${path}`, op]),
  )
}

const serverOps = new Map(operations(SERVER))

/** The Money regex from schemas/common.ts, as it appears in the spec. */
const MONEY_PATTERN = '^-?\\d+\\.\\d{2}$'

/**
 * A canonical form of a JSON schema: `anyOf [X, null]`, `type [X, "null"]`, and
 * `allOf [$ref, {default}]` all become X plus `nullable` or `default`; the `Money` pattern is
 * dropped, so a money field reads as a plain string.
 */
function canonical(schema: Schema): Schema {
  let out: Schema = { ...schema }
  let nullable = false
  if (Array.isArray(out.anyOf)) {
    const { anyOf, ...rest } = out
    const all = anyOf as Schema[]
    const branches = all.filter((b) => b.type !== 'null')
    nullable = branches.length < all.length
    if (branches.length === 1) out = { ...rest, ...branches[0] }
    else out = { ...rest, anyOf: branches.map(canonical) }
  }
  if (Array.isArray(out.allOf)) {
    const { allOf, ...rest } = out
    out = Object.assign({}, ...(allOf as Schema[]), rest)
  }
  if (Array.isArray(out.type)) {
    const types = (out.type as string[]).filter((t) => t !== 'null')
    nullable ||= types.length < (out.type as string[]).length
    out.type = types.length === 1 ? types[0] : types
  }
  if (out.pattern === MONEY_PATTERN) delete out.pattern
  if (out.items) out.items = canonical(out.items as Schema)
  if (nullable) out.nullable = true
  return out
}

function canonicalProperties(schema: Schema): Record<string, Schema> {
  const properties = (schema.properties ?? {}) as Record<string, Schema>
  return Object.fromEntries(Object.entries(properties).map(([name, s]) => [name, canonical(s)]))
}

const sorted = (values: unknown) => [...((values as string[] | undefined) ?? [])].sort()

describe('the new config contract (schemas/settings.ts)', () => {
  const schemas = SERVER.components.schemas

  it('reads every config knob', () => {
    expect(sorted(schemas.ConfigRead?.required)).toEqual(
      sorted([
        'llm_provider',
        'llm_model',
        'anthropic_api_key_set',
        'ollama_base_url',
        'owner_name_tokens',
        'sync_interval_hours',
        'sync_first_history_days',
        'scheduler_enabled',
      ]),
    )
    expect(canonicalProperties(schemas.ConfigRead ?? {})).toMatchObject({
      llm_provider: { type: 'string', enum: ['claude', 'ollama', 'fake'] },
      llm_model: { type: 'string' },
      anthropic_api_key_set: { type: 'boolean' },
      ollama_base_url: { type: 'string' },
      owner_name_tokens: { type: 'array', items: { type: 'string' } },
      sync_interval_hours: { type: 'integer' },
      sync_first_history_days: { type: 'integer' },
      scheduler_enabled: { type: 'boolean' },
    })
  })

  it('updates any knob, writes the key instead of reading whether it is set, and null clears it', () => {
    const update = schemas.ConfigUpdate ?? {}
    expect(update.required ?? []).toEqual([])
    expect(update.additionalProperties).toBe(false)
    const properties = canonicalProperties(update)
    expect(Object.keys(properties).sort()).toEqual(
      sorted([
        'llm_provider',
        'llm_model',
        'anthropic_api_key',
        'ollama_base_url',
        'owner_name_tokens',
        'sync_interval_hours',
        'sync_first_history_days',
        'scheduler_enabled',
      ]),
    )
    expect(properties.anthropic_api_key).toMatchObject({ type: 'string', nullable: true })
    expect(properties.llm_model?.nullable).toBeUndefined()
    expect(properties.llm_model).toMatchObject({ type: 'string', minLength: 1 })
    expect(properties.sync_interval_hours).toMatchObject({ type: 'integer', minimum: 1 })
    expect(properties.sync_first_history_days).toMatchObject({ type: 'integer', minimum: 1 })
  })

  it('is served at GET and PUT /api/settings/config', () => {
    expect(serverOps.get('GET /api/settings/config')).toMatchObject({
      operationId: 'get_config',
      tags: ['settings'],
      responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ConfigRead' } } } } },
    })
    expect(serverOps.get('PUT /api/settings/config')).toMatchObject({
      operationId: 'update_config',
      tags: ['settings'],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ConfigUpdate' } } } },
      responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ConfigRead' } } } } },
    })
  })
})

describe('route guards', () => {
  it('every route declares a response schema or is 204, and has a tag', () => {
    // Walk the app's own routes, not just the document, so a route registered outside
    // @hono/zod-openapi cannot slip past the check.
    const { app } = makeApp()
    const registered = new Set(
      app.routes
        .filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/') && r.path !== '/api/openapi.json')
        .map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, '{$1}')}`),
    )
    expect(registered.size).toBeGreaterThan(30)
    expect([...registered].sort()).toEqual([...serverOps.keys()].sort())
    for (const [key, op] of serverOps) {
      const success = Object.entries(op.responses).filter(([status]) => status.startsWith('2'))
      expect(success.length, key).toBe(1)
      const [status, response] = success[0] ?? []
      const declared = status === '204' || response?.content?.['application/json']?.schema !== undefined
      expect(declared, `${key} declares no response schema`).toBe(true)
      expect(op.tags?.length, `${key} has no tag`).toBeGreaterThan(0)
    }
  })

  it('operation ids are unique', () => {
    const ids = [...serverOps.values()].map((op) => op.operationId)
    expect(ids.length).toBe(new Set(ids).size)
  })

  it('the committed OpenAPI spec is current', () => {
    const committed: unknown = JSON.parse(readFileSync(SPEC_PATH, 'utf8'))
    expect(committed, 'OpenAPI spec is stale. Run `make openapi` and commit the result.').toEqual(SERVER)
  })
})

/** A valid request for every stubbed operation, so validation passes and the stub answers. */
const SAMPLES: Record<string, { query?: string; body?: unknown }> = {
  list_accounts: {},
  start_sync: {},
  recalculate: {},
  get_sync_schedule: {},
  list_sync_runs: { query: 'limit=20' },
  get_sync_run: {},
  get_simplefin_status: {},
  connect_simplefin: { body: { setup_token: 'fake-setup-token' } },
  disconnect_simplefin: {},
  get_llm_status: {},
  get_config: {},
  update_config: { body: { llm_model: 'claude-haiku-4-5', anthropic_api_key: null } },
  list_transactions: {
    query:
      'q=coffee&start=2026-01-01&end=2026-01-31&account_id=1&account_id=2&category_id=3' +
      '&essentiality=unset&uncategorized=true&needs_review=false&include_transfers=1&limit=500&offset=0',
  },
  update_transaction: {
    body: { category_id: 1, note: '', save_as_rule: true, rule_match_type: 'prefix', rule_pattern: 'UBER' },
  },
  unpair_transaction: {},
  get_transaction_rule: {},
  list_categories: { query: 'include_hidden=true' },
  create_category: { body: { primary: 'FOOD_AND_DRINK', label: 'Snacks' } },
  update_category: { body: { label: 'Snacks', is_hidden: false } },
  list_rules: {},
  create_rule: { body: { match_type: 'prefix', pattern: 'UBER', category_id: 1, essentiality: null } },
  preview_rule: { body: { match_type: 'contains', pattern: 'uber' } },
  update_rule: { body: { category_id: 1 } },
  delete_rule: {},
  get_changes: { query: 'all=true' },
  dismiss_change: { body: { key: 'S1:fake' } },
  clear_change_dismissals: {},
  get_monthly_summary: { query: 'months=60' },
  get_month_detail: {},
  get_spending_by_category: { query: 'month=2026-01&essentiality=essential' },
  get_balance_history: { query: 'start=2026-01-01&end=2026-03-31' },
  get_projection: { query: 'months=12' },
  list_recurring: { query: 'status=confirmed' },
  mark_recurring: { body: { transaction_id: 1, cadence: 'monthly' } },
  update_recurring: { body: { status: 'dismissed', essentiality: null, amount: '-15.49', cadence: 'yearly' } },
  list_manual_entries: {},
  create_manual_entry: { body: { amount: '-1200.00', description: 'Rent', due_date: '2026-11-01', recurrence: 'monthly' } },
  update_manual_entry: { body: { end_date: '2027-11-01', fulfilled_transaction_id: null } },
  delete_manual_entry: {},
  list_goals: {},
  create_goal: { body: { name: 'Trip', target_amount: '1000.00', target_date: '2027-06-01' } },
  get_goal: {},
  update_goal: { body: { name: 'Trip', target_amount: '1500.00', is_active: false } },
  list_suggestions: {},
  generate_suggestions: {},
  update_suggestion: { body: { status: 'kept' } },
}

function sampleUrl(path: string, query?: string): string {
  const filled = path.replace('{month}', '2026-01').replace(/\{\w+\}/g, '1')
  return query ? `${filled}?${query}` : filled
}

async function call(method: string, url: string, body?: unknown): Promise<Response> {
  const { app } = makeApp()
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  return app.request(url, init)
}

/**
 * A valid request for every operation reaches a real handler: anything but a validation error
 * or a server error (on an empty database that is often 404; a fake SimpleFIN token is a 502
 * upstream provider error, decided without the network). Wave 3 retired the last 501 stub, so
 * no operation may answer 501 any more.
 */
const parsed = (status: number) => status !== 422 && (status < 500 || status === 502)

describe('every operation accepts its sample request and is implemented', () => {
  const ops = [...serverOps].filter(([, op]) => op.operationId !== 'get_health')

  it('has a sample request for every operation', () => {
    expect(ops.map(([, op]) => op.operationId).sort()).toEqual(Object.keys(SAMPLES).sort())
  })

  it.each(ops)('%s', async (key, op) => {
    const [method = '', path = ''] = key.split(' ')
    const sample = SAMPLES[op.operationId] ?? {}
    const res = await call(method, sampleUrl(path, sample.query), sample.body)
    expect(res.status).toSatisfy(parsed)
  })
})

/**
 * Request parsing is lenient about strings for numbers and booleans. A request that parses
 * reaches the handler (`parsed`: the route's own answer); one that does not is a 422 problem.
 */
describe('request parsing', () => {
  async function status(method: string, url: string, body?: unknown) {
    const res = await call(method, url, body)
    if (res.status === 422) expect(res.headers.get('content-type')).toBe('application/problem+json')
    return res.status
  }

  it.each(['true', 'True', 'TRUE', '1', 'yes', 'on', 't', 'y', 'false', '0', 'no', 'off', 'f', 'n'])(
    'accepts the boolean %j',
    async (value) => {
      expect(await status('GET', `/api/categories?include_hidden=${value}`)).toSatisfy(parsed)
    },
  )

  it.each(['', '2', 'enabled', ' true', 'maybe'])('rejects the boolean %j', async (value) => {
    expect(await status('GET', `/api/categories?include_hidden=${encodeURIComponent(value)}`)).toBe(422)
  })

  it.each(['5', '+5', '05', '5.0', ' 5', '1_0', '500'])('accepts the integer %j', async (value) => {
    expect(await status('GET', `/api/transactions?limit=${encodeURIComponent(value)}`)).toSatisfy(parsed)
  })

  it.each(['', '5.5', '1e2', '0x10', 'five', '0', '501'])('rejects the integer %j or its bounds', async (value) => {
    expect(await status('GET', `/api/transactions?limit=${encodeURIComponent(value)}`)).toBe(422)
  })

  it('takes repeated list parameters and a single one', async () => {
    expect(await status('GET', '/api/transactions?account_id=1&account_id=2')).toSatisfy(parsed)
    expect(await status('GET', '/api/transactions?category_id=3')).toSatisfy(parsed)
    expect(await status('GET', '/api/transactions?account_id=1&account_id=x')).toBe(422)
  })

  it('checks enums, dates, and patterns in the query and path', async () => {
    expect(await status('GET', '/api/transactions?essentiality=sometimes')).toBe(422)
    expect(await status('GET', '/api/transactions?start=2026-02-30')).toBe(422)
    expect(await status('GET', '/api/reports/by-category')).toBe(422)
    expect(await status('GET', '/api/reports/by-category?month=2026-1')).toBe(422)
    expect(await status('GET', '/api/reports/month/2026-1')).toBe(422)
    expect(await status('GET', '/api/recurring?status=maybe')).toBe(422)
  })

  it('checks integer path parameters', async () => {
    expect(await status('GET', '/api/goals/abc')).toBe(422)
    expect(await status('GET', '/api/goals/-1')).toSatisfy(parsed)
  })

  it('forbids extra fields in request bodies (Schema, extra="forbid")', async () => {
    expect(await status('POST', '/api/goals', { name: 'Trip', target_amount: '1.00', target_date: '2027-06-01', x: 1 })).toBe(
      422,
    )
  })

  it('checks request body bounds', async () => {
    const goal = { name: 'Trip', target_amount: '1000.00', target_date: '2027-06-01' }
    expect(await status('POST', '/api/goals', { ...goal, name: '' })).toBe(422)
    expect(await status('POST', '/api/goals', { ...goal, name: 'x'.repeat(256) })).toBe(422)
    expect(await status('POST', '/api/goals', { ...goal, target_amount: '0.00' })).toBe(422)
    expect(await status('POST', '/api/goals', { ...goal, target_amount: '-5.00' })).toBe(422)
    expect(await status('PATCH', '/api/goals/1', { target_amount: '0.00' })).toBe(422)
    expect(await status('PATCH', '/api/transactions/1', { note: 'x'.repeat(501) })).toBe(422)
    expect(await status('POST', '/api/categories', { primary: 'x'.repeat(101), label: 'Snacks' })).toBe(422)
    expect(await status('POST', '/api/settings/simplefin', { setup_token: '' })).toBe(422)
    expect(await status('POST', '/api/reports/changes/dismiss', { key: 'x'.repeat(256) })).toBe(422)
  })

  it('requires required body fields and accepts empty updates', async () => {
    expect(await status('POST', '/api/recurring', { transaction_id: 1 })).toBe(422)
    expect(await status('PATCH', '/api/manual-entries/1', {})).toSatisfy(parsed)
    expect(await status('PUT', '/api/settings/config', {})).toSatisfy(parsed)
    expect(await status('PUT', '/api/settings/config', { llm_provider: 'gpt' })).toBe(422)
    expect(await status('PUT', '/api/settings/config', { llm_model: null })).toBe(422)
  })

  it('bounds the config knobs', async () => {
    expect(await status('PUT', '/api/settings/config', { llm_model: '' })).toBe(422)
    expect(await status('PUT', '/api/settings/config', { sync_interval_hours: 0 })).toBe(422)
    expect(await status('PUT', '/api/settings/config', { sync_first_history_days: 0 })).toBe(422)
    expect(
      await status('PUT', '/api/settings/config', { llm_model: 'x', sync_interval_hours: 1, sync_first_history_days: 1 }),
    ).toSatisfy(parsed)
  })

  it('takes request money as a number or a decimal string', async () => {
    const entry = { description: 'Rent', due_date: '2026-11-01' }
    for (const amount of ['-15.49', '1000', '15.5', 15.5, -1200]) {
      expect(await status('POST', '/api/manual-entries', { ...entry, amount })).toSatisfy(parsed)
      expect(await status('PATCH', '/api/manual-entries/1', { amount })).toSatisfy(parsed)
      expect(await status('PATCH', '/api/recurring/1', { amount })).toSatisfy(parsed)
    }
    expect(await status('PATCH', '/api/manual-entries/1', { amount: null })).toSatisfy(parsed)
    expect(await status('POST', '/api/manual-entries', { ...entry, amount: '1e3' })).toBe(422)
    expect(await status('POST', '/api/goals', { name: 'Trip', target_amount: 1000, target_date: '2027-06-01' })).toSatisfy(parsed)
    expect(await status('PATCH', '/api/goals/1', { target_amount: '0' })).toBe(422)
  })
})

describe('MoneyInput', () => {
  it.each([
    ['1000', 100000],
    ['15.5', 1550],
    ['-15.49', -1549],
    [15.5, 1550],
    [1000, 100000],
    [-15.49, -1549],
    ['0.005', 1], // extra places round half away from zero (stored amounts' rule)
    ['-0.005', -1],
    ['0.004', 0],
    ['+7', 700],
    ['1.', 100],
    ['.5', 50],
    ['007.10', 710],
    ['90071992547409.91', Number.MAX_SAFE_INTEGER],
  ])('parses %j to %d cents', (input, expected) => {
    const result = MoneyInput.safeParse(input)
    expect(result.success).toBe(true)
    expect(result.data).toBe(expected)
  })

  it.each(['abc', '1e3', '', '.', '+', '-', '1,000.00', ' 1', '1.2.3', 1e21, 1e-7, '90071992547409.92', null, true])(
    'rejects %j',
    (input) => {
      expect(MoneyInput.safeParse(input).success).toBe(false)
    },
  )

  it('is nullable where the schema allows null', () => {
    expect(MoneyInput.nullable().safeParse(null)).toEqual({ success: true, data: null })
  })

  it.each([['1000', 100000], [0.5, 50], ['0.01', 1]])('PositiveMoneyInput (gt=0) parses %j', (input, expected) => {
    expect(PositiveMoneyInput.safeParse(input).data).toBe(expected)
  })

  it.each(['0', '-1', 0, -1, '0.00', '-0.5', -0.01])('PositiveMoneyInput (gt=0) rejects %j', (input) => {
    expect(PositiveMoneyInput.safeParse(input).success).toBe(false)
  })
})

/** Hono's json validator answers 415 or 400 text/plain; the app turns both into 422. */
describe('JSON body errors are 422 problem+json', () => {
  const goal = JSON.stringify({ name: 'Trip', target_amount: '1000.00', target_date: '2027-06-01' })

  it.each<[string, RequestInit]>([
    ['a missing Content-Type', { method: 'POST', body: goal }],
    ['a wrong Content-Type', { method: 'POST', body: goal, headers: { 'Content-Type': 'text/plain' } }],
    ['malformed JSON', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } }],
    ['an empty body', { method: 'POST', headers: { 'Content-Type': 'application/json' } }],
  ])('%s', async (_, init) => {
    const { app } = makeApp()
    const res = await app.request('/api/goals', init)
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ type: 'about:blank', title: 'Validation error', status: 422, instance: '/api/goals' })
    expect(body.detail).toMatch(/^body: \S/)
  })

  it('leaves other HTTP exceptions alone', async () => {
    const { app } = makeApp()
    app.get('/api/test/bad-request', () => {
      throw new HTTPException(400, { message: 'Malformed something else' })
    })
    app.get('/api/test/unsupported', () => {
      throw new HTTPException(406, { message: 'Not acceptable' })
    })
    expect((await app.request('/api/test/bad-request')).status).toBe(400)
    expect((await app.request('/api/test/unsupported')).status).toBe(406)
  })
})
