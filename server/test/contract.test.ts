/**
 * Guards on the API contract that every brief must keep true. Ports api/tests/test_contract.py
 * (its route guards and the committed-spec staleness check; the models-versus-migrations guard
 * lives in db.test.ts) and adds brief 0B's structural check against FastAPI's spec, frozen in
 * test/fixtures/fastapi-openapi.json as the oracle for the contract.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderOpenApi } from '../scripts/export-openapi.js'
import { FIXTURES, makeApp } from './setup.js'

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
const FASTAPI: Spec = JSON.parse(readFileSync(`${FIXTURES}fastapi-openapi.json`, 'utf8'))
const SERVER: Spec = JSON.parse(renderOpenApi())

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']

/** `/auth/*` is not ported (brief 0B). */
const notPorted = (path: string) => path.startsWith('/api/auth/')

/** Routes the plan adds on purpose (brief 0B, schemas/settings.ts). */
const NEW_ROUTES = ['GET /api/settings/config', 'PUT /api/settings/config']

/** FastAPI components the server does not have, with the reason. */
const NOT_PORTED_COMPONENTS: Record<string, string> = {
  LoginRequest: 'auth is not ported',
  SessionRead: 'auth is not ported',
  HTTPValidationError: "FastAPI's 422 body; the server answers 422 problem+json (plan 5.5)",
  ValidationError: "FastAPI's 422 body; the server answers 422 problem+json (plan 5.5)",
}

/**
 * Components from brief 0A (schemas/common.ts and schemas/health.ts, orchestrator-owned) that
 * do not yet carry Pydantic's titles; their titles are skipped until those files add them.
 */
const TITLES_PENDING = new Set(['HealthRead', 'Page_TransactionRead_'])

function operations(spec: Spec): Array<[string, Operation]> {
  return Object.entries(spec.paths).flatMap(([path, ops]) =>
    Object.entries(ops)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, op]): [string, Operation] => [`${method.toUpperCase()} ${path}`, op]),
  )
}

const fastapiOps = new Map(operations(FASTAPI).filter(([key]) => !notPorted(key.split(' ')[1] ?? '')))
const serverOps = new Map(operations(SERVER))

/** The server's operation for a FastAPI one; a missing operation fails the test. */
function serverOp(key: string): Operation {
  const op = serverOps.get(key)
  expect(op, `${key} is missing`).toBeDefined()
  return op as Operation
}

/** The server's component for a FastAPI one; a missing component fails the test. */
function serverSchema(name: string): Schema {
  const schema = SERVER.components.schemas[name]
  expect(schema, `${name} is missing`).toBeDefined()
  return schema as Schema
}

/** The Money regex from schemas/common.ts, as it appears in the spec. */
const MONEY_PATTERN = '^-?\\d+\\.\\d{2}$'
/** Pydantic's pattern for a Decimal given as a string. */
const DECIMAL_PATTERN = '^(?!^[-+.]*$)[+-]?0*\\d*\\.?\\d*$'

/**
 * A canonical form of a JSON schema so FastAPI's and zod-openapi's spellings of the same type
 * compare equal: `anyOf [X, null]`, `type [X, "null"]`, and `allOf [$ref, {default}]` all
 * become X plus `nullable` or `default`. Money is a plain string on both sides: Pydantic
 * documented a Decimal input as `number | decimal string` and a Money output as a string; the
 * server documents `Money` (plan 5.2) everywhere.
 */
function canonical(schema: Schema): Schema {
  let out: Schema = { ...schema }
  let nullable = false
  if (Array.isArray(out.anyOf)) {
    const { anyOf, ...rest } = out
    const all = anyOf as Schema[]
    const branches = all.filter((b) => b.type !== 'null')
    nullable = branches.length < all.length
    const isDecimal =
      branches.length === 2 && branches[0]?.type === 'number' && branches[1]?.pattern === DECIMAL_PATTERN
    if (isDecimal) out = { ...rest, type: 'string' }
    else if (branches.length === 1) out = { ...rest, ...branches[0] }
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

describe('routes match FastAPI', () => {
  it('has the same METHOD path pairs, apart from /auth/* and the new config routes', () => {
    const expected = [...fastapiOps.keys(), ...NEW_ROUTES].sort()
    expect([...serverOps.keys()].sort()).toEqual(expected)
  })

  it.each([...fastapiOps.keys()])('%s keeps its operation id, summary, description, and tags', (key) => {
    const old = fastapiOps.get(key)
    const now = serverOp(key)
    expect({
      operationId: now?.operationId,
      summary: now?.summary,
      description: now?.description,
      tags: now?.tags,
    }).toEqual({
      operationId: old?.operationId,
      summary: old?.summary,
      description: old?.description,
      tags: old?.tags,
    })
  })

  it.each([...fastapiOps.keys()])('%s keeps its parameters, names, defaults, and bounds', (key) => {
    const params = (op: Operation | undefined) =>
      (op?.parameters ?? [])
        .map((p) => ({ in: p.in, name: p.name, required: p.required, schema: canonical(p.schema) }))
        .sort((a, b) => a.name.localeCompare(b.name))
    expect(params(serverOp(key))).toEqual(params(fastapiOps.get(key)))
  })

  it.each([...fastapiOps.keys()])('%s keeps its request body', (key) => {
    const body = (op: Operation | undefined) => {
      const rb = op?.requestBody
      if (rb === undefined) return null
      return {
        required: rb.required,
        content: Object.fromEntries(Object.entries(rb.content).map(([type, c]) => [type, canonical(c.schema)])),
      }
    }
    expect(body(serverOp(key))).toEqual(body(fastapiOps.get(key)))
  })

  it.each([...fastapiOps.keys()])('%s keeps its success responses', (key) => {
    // FastAPI documented a 422 HTTPValidationError on every route with input; the server's 422
    // is problem+json (plan 5.5) and, like FastAPI's other errors, undocumented.
    const responses = (op: Operation | undefined) =>
      Object.fromEntries(
        Object.entries(op?.responses ?? {})
          .filter(([status]) => status !== '422')
          .map(([status, r]) => [
            status,
            {
              description: r.description,
              content: Object.fromEntries(
                Object.entries(r.content ?? {}).map(([type, c]) => [type, canonical(c.schema)]),
              ),
            },
          ]),
      )
    expect(responses(serverOp(key))).toEqual(responses(fastapiOps.get(key)))
  })
})

describe('component schemas match FastAPI', () => {
  const ported = Object.keys(FASTAPI.components.schemas).filter((name) => !(name in NOT_PORTED_COMPONENTS))
  const serverSchemas = SERVER.components.schemas

  it('has every FastAPI component schema name, apart from auth and the 422 body', () => {
    const missing = ported.filter((name) => !(name in serverSchemas))
    expect(missing).toEqual([])
  })

  it('has no components beyond those and the new config contract', () => {
    expect(Object.keys(serverSchemas).sort()).toEqual([...ported, 'ConfigRead', 'ConfigUpdate'].sort())
  })

  it.each(ported)('%s has the same required property names', (name) => {
    expect(sorted(serverSchema(name).required)).toEqual(sorted(FASTAPI.components.schemas[name]?.required))
  })

  it.each(ported)('%s has the same title, description, properties, and enum values', (name) => {
    const untitled = TITLES_PENDING.has(name)
    const strip = ({ title, ...rest }: Schema): Schema => (untitled ? rest : { title, ...rest })
    const shape = (s: Schema | undefined) => ({
      title: untitled ? undefined : s?.title,
      description: s?.description,
      type: s?.type,
      enum: s?.enum,
      default: s?.default,
      additionalProperties: s?.additionalProperties,
      properties: Object.fromEntries(Object.entries(canonicalProperties(s ?? {})).map(([k, v]) => [k, strip(v)])),
    })
    expect(shape(serverSchema(name))).toEqual(shape(FASTAPI.components.schemas[name]))
  })
})

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

describe('route guards (test_contract.py)', () => {
  it('every route declares a response schema or is 204, and has a tag', () => {
    // Walk the app's own routes, not just the document, so a route registered outside
    // @hono/zod-openapi cannot slip past the check (the lesson of test_contract.py).
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
  update_transaction: { body: { category_id: 1, note: '', save_as_rule: true, rule_match_type: 'prefix' } },
  list_categories: { query: 'include_hidden=true' },
  create_category: { body: { primary: 'FOOD_AND_DRINK', label: 'Snacks' } },
  update_category: { body: { label: 'Snacks', is_hidden: false } },
  list_rules: {},
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

describe('every stub answers 501 problem+json', () => {
  const stubs = [...serverOps].filter(([, op]) => op.operationId !== 'get_health')

  it('has a sample request for every stub', () => {
    expect(stubs.map(([, op]) => op.operationId).sort()).toEqual(Object.keys(SAMPLES).sort())
  })

  it.each(stubs)('%s', async (key, op) => {
    const [method = '', path = ''] = key.split(' ')
    const sample = SAMPLES[op.operationId] ?? {}
    const res = await call(method, sampleUrl(path, sample.query), sample.body)
    expect(res.status).toBe(501)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Not implemented',
      status: 501,
      detail: 'Not implemented yet',
      instance: sampleUrl(path),
    })
  })
})

/**
 * Request parsing mirrors FastAPI and Pydantic's lax mode. A request that parses reaches the
 * stub (501); one that does not is a 422 problem.
 */
describe('request parsing (FastAPI and Pydantic lax mode)', () => {
  async function status(method: string, url: string, body?: unknown) {
    const res = await call(method, url, body)
    if (res.status === 422) expect(res.headers.get('content-type')).toBe('application/problem+json')
    return res.status
  }

  it.each(['true', 'True', 'TRUE', '1', 'yes', 'on', 't', 'y', 'false', '0', 'no', 'off', 'f', 'n'])(
    'accepts the boolean %j',
    async (value) => {
      expect(await status('GET', `/api/categories?include_hidden=${value}`)).toBe(501)
    },
  )

  it.each(['', '2', 'enabled', ' true', 'maybe'])('rejects the boolean %j', async (value) => {
    expect(await status('GET', `/api/categories?include_hidden=${encodeURIComponent(value)}`)).toBe(422)
  })

  it.each(['5', '+5', '05', '5.0', ' 5', '1_0', '500'])('accepts the integer %j', async (value) => {
    expect(await status('GET', `/api/transactions?limit=${encodeURIComponent(value)}`)).toBe(501)
  })

  it.each(['', '5.5', '1e2', '0x10', 'five', '0', '501'])('rejects the integer %j or its bounds', async (value) => {
    expect(await status('GET', `/api/transactions?limit=${encodeURIComponent(value)}`)).toBe(422)
  })

  it('takes repeated list parameters and a single one', async () => {
    expect(await status('GET', '/api/transactions?account_id=1&account_id=2')).toBe(501)
    expect(await status('GET', '/api/transactions?category_id=3')).toBe(501)
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
    expect(await status('GET', '/api/goals/-1')).toBe(501)
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
    expect(await status('PATCH', '/api/manual-entries/1', {})).toBe(501)
    expect(await status('PUT', '/api/settings/config', {})).toBe(501)
    expect(await status('PUT', '/api/settings/config', { llm_provider: 'gpt' })).toBe(422)
    expect(await status('PUT', '/api/settings/config', { llm_model: null })).toBe(422)
  })

  it('takes money as a string with two decimals (plan 5.2)', async () => {
    const entry = { description: 'Rent', due_date: '2026-11-01' }
    expect(await status('POST', '/api/manual-entries', { ...entry, amount: '-15.49' })).toBe(501)
    expect(await status('POST', '/api/manual-entries', { ...entry, amount: -15.49 })).toBe(422)
  })
})
