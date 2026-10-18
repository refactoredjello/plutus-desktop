/**
 * The scripted write sequence, run on both apps in order. Each step picks its target from the
 * app's own responses (so a step never sends one app's ids to the other), sends one write,
 * captures ids later steps need, and names the GETs to re-read afterwards.
 */

import type { Envelope } from './diff.ts'
import { addDays, monthOffset } from './endpoints.ts'
import type { Json } from './normalize.ts'

export interface Api {
  send(method: string, path: string, body?: Json): Promise<Envelope>
}

/** Ids captured by earlier steps, per app. */
export type State = Record<string, Json>

export interface StepRequest {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  path: string
  body?: Json
}

export interface WriteStep {
  name: string
  /** The template the request resolves to; groups the report. */
  endpoint: string
  prepare(api: Api, state: State, today: string): Promise<StepRequest> | StepRequest
  capture?(response: Envelope, state: State): void
  /** Wait for background work the write started (a sync); null when done, else why not. */
  settle?(api: Api, state: State): Promise<string | null>
  /** GET paths to compare after the write. */
  reread(state: State, today: string): string[]
}

/** The app lacks data the step needs. On the TypeScript side this is a reported difference. */
export class PrepareError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrepareError'
  }
}

type Obj = { [key: string]: Json }

const isObj = (v: Json | undefined): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

export async function getJson(api: Api, path: string): Promise<Json> {
  const res = await api.send('GET', path)
  if (res.status !== 200) throw new PrepareError(`GET ${path} answered ${res.status}`)
  return res.body
}

async function getList(api: Api, path: string, key?: string): Promise<Obj[]> {
  const body = await getJson(api, path)
  const list = key === undefined ? body : isObj(body) ? body[key] : undefined
  if (!Array.isArray(list)) throw new PrepareError(`GET ${path} did not return a list`)
  return list.filter(isObj)
}

function pick<T>(items: T[], what: string, test: (item: T) => boolean): T {
  const hit = items.find(test)
  if (hit === undefined) throw new PrepareError(`no ${what}`)
  return hit
}

function need(state: State, key: string): Json {
  const value = state[key]
  if (value === undefined || value === null) throw new PrepareError(`an earlier step did not capture ${key}`)
  return value
}

function captureId(key: string) {
  return (res: Envelope, state: State) => {
    const body = Array.isArray(res.body) ? res.body[0] : res.body
    if (res.status < 300 && isObj(body) && body.id !== undefined) state[key] = body.id
  }
}

const month = (today: string) => today.slice(0, 7)
const TX_ALL = '/api/transactions?limit=500'
const REVIEW = '/api/transactions?needs_review=true&limit=500'
const CHANGES = ['/api/reports/changes', '/api/reports/changes?all=true']
const isOutflow = (t: Obj) => typeof t.amount === 'string' && t.amount.startsWith('-')

/** Ids the edge-case steps must not pick again, so each one changes a fresh row. */
function used(state: State, ...keys: string[]): Set<Json> {
  return new Set(keys.map((k) => state[k]).filter((v): v is Json => v !== undefined && v !== null))
}

const TX_WITH_TRANSFERS = '/api/transactions?include_transfers=true&limit=500'
const MISSING = 999999

async function category(api: Api, detailed: string): Promise<Obj> {
  return pick(await getList(api, '/api/categories'), `${detailed} category`, (c) => c.detailed === detailed)
}

/** Save a rule of `matchType` from the first LLM-categorized outflow not used before. */
function ruleStep(name: string, matchType: string, stateKey: string, exclude: string[]): WriteStep {
  return {
    name,
    endpoint: 'PATCH /api/transactions/{transaction_id}',
    async prepare(api, state) {
      const skip = used(state, ...exclude)
      const txs = await getList(api, TX_ALL, 'items')
      const tx = pick(txs, 'LLM-categorized outflow', (t) => {
        const c = t.categorization
        return (
          typeof t.merchant_key === 'string' &&
          t.is_transfer === false &&
          isOutflow(t) &&
          isObj(c) &&
          c.source === 'llm' &&
          !skip.has(t.id ?? null)
        )
      })
      const coffee = await category(api, 'FOOD_AND_DRINK_COFFEE')
      const current = isObj(tx.categorization) ? tx.categorization.category_id : null
      const target = coffee.id === current ? await category(api, 'FOOD_AND_DRINK_FAST_FOOD') : coffee
      state[stateKey] = tx.id ?? null
      return {
        method: 'PATCH',
        path: `/api/transactions/${tx.id}`,
        body: { category_id: target.id ?? null, essentiality: 'flexible', save_as_rule: true, rule_match_type: matchType },
      }
    },
    reread: (_s, today) => [TX_ALL, '/api/rules', `/api/reports/by-category?month=${month(today)}`],
  }
}

const notedTx = (state: State) => `/api/transactions/${need(state, 'notedId')}`

export const TRANSACTION_EDGES: readonly WriteStep[] = [
  ruleStep('recategorize with a contains rule', 'contains', 'containsId', ['recategorizedId']),
  ruleStep('recategorize with a prefix rule', 'prefix', 'prefixId', ['recategorizedId', 'containsId']),
  {
    name: 'clear a note and essentiality',
    endpoint: 'PATCH /api/transactions/{transaction_id}',
    prepare: (_api, state) => ({ method: 'PATCH', path: notedTx(state), body: { note: '', essentiality: null } }),
    reread: () => ['/api/transactions?q=split&limit=500', REVIEW],
  },
  {
    name: 'add a note with accents',
    endpoint: 'PATCH /api/transactions/{transaction_id}',
    async prepare(api, state) {
      const skip = used(state, 'recategorizedId', 'containsId', 'prefixId', 'notedId')
      const txs = await getList(api, TX_ALL, 'items')
      const tx = pick(
        txs,
        'transaction without a note',
        (t) => t.note === null && t.is_transfer === false && !skip.has(t.id ?? null),
      )
      state.accentId = tx.id ?? null
      return {
        method: 'PATCH',
        path: `/api/transactions/${tx.id}`,
        body: { note: 'Caf\u00e9 \u00e9t\u00e9 \u00c9T\u00c9 (parity)' },
      }
    },
    reread: () => [
      `/api/transactions?q=${encodeURIComponent('\u00e9t\u00e9')}&limit=500`,
      `/api/transactions?q=${encodeURIComponent('\u00c9T\u00c9')}&limit=500`,
      `/api/transactions?q=${encodeURIComponent('caf\u00e9')}&limit=500`,
    ],
  },
  {
    name: 'recategorize to an unknown category',
    endpoint: 'PATCH /api/transactions/{transaction_id}',
    prepare: (_api, state) => ({ method: 'PATCH', path: notedTx(state), body: { category_id: MISSING } }),
    reread: () => [],
  },
  {
    name: 'edit a note with save_as_rule false',
    endpoint: 'PATCH /api/transactions/{transaction_id}',
    async prepare(api, state) {
      const skip = used(state, 'recategorizedId', 'containsId', 'prefixId', 'notedId', 'accentId')
      const txs = await getList(api, TX_ALL, 'items')
      const tx = pick(
        txs,
        'categorized outflow',
        (t) => t.is_transfer === false && isOutflow(t) && isObj(t.categorization) && !skip.has(t.id ?? null),
      )
      return {
        method: 'PATCH',
        path: `/api/transactions/${tx.id}`,
        body: { note: 'Parity default flag', save_as_rule: false },
      }
    },
    reread: () => ['/api/transactions?q=default%20flag&limit=500', REVIEW],
  },
  {
    name: 'reject an invalid transaction update',
    endpoint: 'PATCH /api/transactions/{transaction_id}',
    prepare: (_api, state) => ({
      method: 'PATCH',
      path: notedTx(state),
      body: { essentiality: 'bogus', rule_match_type: 'regex', note: 'x'.repeat(501), colour: 'blue' },
    }),
    reread: () => [],
  },
  {
    name: 'update a transaction with no body',
    endpoint: 'PATCH /api/transactions/{transaction_id}',
    prepare: (_api, state) => ({ method: 'PATCH', path: notedTx(state) }),
    reread: () => [],
  },
  {
    name: 'update a transaction with an empty body',
    endpoint: 'PATCH /api/transactions/{transaction_id}',
    prepare: (_api, state) => ({ method: 'PATCH', path: notedTx(state), body: {} }),
    reread: () => [],
  },
]

export const RECURRING_EDGES: readonly WriteStep[] = [
  {
    name: 'mark a missing transaction recurring',
    endpoint: 'POST /api/recurring',
    prepare: () => ({ method: 'POST', path: '/api/recurring', body: { transaction_id: MISSING, cadence: 'monthly' } }),
    reread: () => [],
  },
  {
    name: 'mark a transfer recurring',
    endpoint: 'POST /api/recurring',
    async prepare(api) {
      const tx = pick(await getList(api, TX_WITH_TRANSFERS, 'items'), 'transfer', (t) => t.is_transfer === true)
      return { method: 'POST', path: '/api/recurring', body: { transaction_id: tx.id ?? null, cadence: 'monthly' } }
    },
    reread: () => [],
  },
  {
    name: 'reject a bad cadence',
    endpoint: 'POST /api/recurring',
    prepare: () => ({ method: 'POST', path: '/api/recurring', body: { transaction_id: 1, cadence: 'fortnightly' } }),
    reread: () => [],
  },
  {
    name: 're-mark a dismissed recurrence',
    endpoint: 'POST /api/recurring',
    async prepare(api, state) {
      const key = need(state, 'dismissedKey')
      const txs = await getList(api, TX_WITH_TRANSFERS, 'items')
      const tx = pick(txs, `transaction of ${String(key)}`, (t) => t.merchant_key === key)
      return { method: 'POST', path: '/api/recurring', body: { transaction_id: tx.id ?? null, cadence: 'monthly' } }
    },
    reread: () => ['/api/recurring', '/api/recurring?status=dismissed', '/api/projection'],
  },
  {
    name: 'change a recurrence cadence and amount',
    endpoint: 'PATCH /api/recurring/{recurring_id}',
    prepare: (_api, state) => ({
      method: 'PATCH',
      path: `/api/recurring/${need(state, 'confirmedId')}`,
      body: { cadence: 'weekly', amount: '-21.99', essentiality: null },
    }),
    reread: () => ['/api/recurring', '/api/projection', '/api/projection?months=12'],
  },
  {
    name: 'update a missing recurrence',
    endpoint: 'PATCH /api/recurring/{recurring_id}',
    prepare: () => ({ method: 'PATCH', path: `/api/recurring/${MISSING}`, body: { status: 'confirmed' } }),
    reread: () => [],
  },
  {
    name: 'reject an invalid recurrence update',
    endpoint: 'PATCH /api/recurring/{recurring_id}',
    prepare: (_api, state) => ({
      method: 'PATCH',
      path: `/api/recurring/${need(state, 'confirmedId')}`,
      body: { status: 'paused', cadence: 'daily' },
    }),
    reread: () => [],
  },
]

const ENTRIES = ['/api/manual-entries', '/api/projection']

function entryCreate(name: string, body: (today: string) => Obj): WriteStep {
  return {
    name,
    endpoint: 'POST /api/manual-entries',
    prepare: (_api, _state, today) => ({ method: 'POST', path: '/api/manual-entries', body: body(today) }),
    reread: () => ENTRIES,
  }
}

export const MANUAL_ENTRY_EDGES: readonly WriteStep[] = [
  entryCreate('reject end_date on a one-off entry', (today) => ({
    amount: '-10.00',
    description: 'Parity one-off',
    due_date: addDays(today, 3),
    recurrence: 'none',
    end_date: addDays(today, 30),
  })),
  entryCreate('reject end_date before due_date', (today) => ({
    amount: '-10.00',
    description: 'Parity backwards',
    due_date: addDays(today, 10),
    recurrence: 'monthly',
    end_date: addDays(today, 1),
  })),
  entryCreate('reject an unknown category on a manual entry', (today) => ({
    amount: '-10.00',
    description: 'Parity unknown category',
    due_date: addDays(today, 3),
    category_id: MISSING,
  })),
  {
    name: 'create a manual entry from a number',
    endpoint: 'POST /api/manual-entries',
    async prepare(api, _state, today) {
      const restaurant = await category(api, 'FOOD_AND_DRINK_RESTAURANT')
      return {
        method: 'POST',
        path: '/api/manual-entries',
        body: {
          amount: -42.5,
          description: 'Parity weekly lunch',
          category_id: restaurant.id ?? null,
          due_date: addDays(today, 2),
          recurrence: 'weekly',
        },
      }
    },
    capture: captureId('numberEntryId'),
    reread: () => [...ENTRIES, '/api/projection?months=6'],
  },
  entryCreate('create a manual entry with a sub-cent amount', (today) => ({
    amount: '12.345',
    description: 'Parity rounding',
    due_date: addDays(today, 4),
    recurrence: 'yearly',
  })),
  entryCreate('create a manual entry with a negative half cent', (today) => ({
    amount: '-0.005',
    description: 'Parity half cent',
    due_date: addDays(today, 6),
  })),
  entryCreate('create a manual entry with an exponent', (today) => ({
    amount: '1e2',
    description: 'Parity exponent',
    due_date: addDays(today, 8),
  })),
  entryCreate('reject a NaN manual entry amount', (today) => ({
    amount: 'NaN',
    description: 'Parity NaN',
    due_date: addDays(today, 8),
  })),
  {
    name: 'mark a manual entry fulfilled',
    endpoint: 'PATCH /api/manual-entries/{entry_id}',
    async prepare(api, state) {
      const tx = pick(await getList(api, TX_ALL, 'items'), 'outflow', (t) => t.is_transfer === false && isOutflow(t))
      return {
        method: 'PATCH',
        path: `/api/manual-entries/${need(state, 'numberEntryId')}`,
        body: { fulfilled_transaction_id: tx.id ?? null },
      }
    },
    reread: () => [...ENTRIES, '/api/projection?months=6'],
  },
  {
    name: 'reject an unknown fulfilled transaction',
    endpoint: 'PATCH /api/manual-entries/{entry_id}',
    prepare: (_api, state) => ({
      method: 'PATCH',
      path: `/api/manual-entries/${need(state, 'entryId')}`,
      body: { fulfilled_transaction_id: MISSING },
    }),
    reread: () => [],
  },
  {
    name: 'reject a null amount',
    endpoint: 'PATCH /api/manual-entries/{entry_id}',
    prepare: (_api, state) => ({
      method: 'PATCH',
      path: `/api/manual-entries/${need(state, 'entryId')}`,
      body: { amount: null },
    }),
    reread: () => [],
  },
  entryCreate('reject an invalid manual entry', () => ({
    amount: 'abc',
    description: '',
    due_date: '2026-02-30',
    recurrence: 'daily',
  })),
  {
    name: 'update a missing manual entry',
    endpoint: 'PATCH /api/manual-entries/{entry_id}',
    prepare: () => ({ method: 'PATCH', path: `/api/manual-entries/${MISSING}`, body: { description: 'Parity' } }),
    reread: () => [],
  },
  {
    name: 'delete a missing manual entry',
    endpoint: 'DELETE /api/manual-entries/{entry_id}',
    prepare: () => ({ method: 'DELETE', path: `/api/manual-entries/${MISSING}` }),
    reread: () => [],
  },
]

const goalPath = (state: State, key = 'goalId') => `/api/goals/${need(state, key)}`

export const GOAL_EDGES: readonly WriteStep[] = [
  {
    name: 'create a goal from a number',
    endpoint: 'POST /api/goals',
    prepare: (_api, _state, today) => ({
      method: 'POST',
      path: '/api/goals',
      body: { name: 'Parity trip', target_amount: 2500, target_date: addDays(today, 200) },
    }),
    capture: captureId('goal2Id'),
    reread: () => ['/api/goals'],
  },
  {
    name: 'move a goal into the past',
    endpoint: 'PATCH /api/goals/{goal_id}',
    prepare: (_api, state, today) => ({ method: 'PATCH', path: goalPath(state), body: { target_date: today } }),
    reread: () => [],
  },
  {
    name: 'reject a null goal name',
    endpoint: 'PATCH /api/goals/{goal_id}',
    prepare: (_api, state) => ({ method: 'PATCH', path: goalPath(state), body: { name: null } }),
    reread: () => [],
  },
  {
    name: 'deactivate a goal',
    endpoint: 'PATCH /api/goals/{goal_id}',
    prepare: (_api, state) => ({ method: 'PATCH', path: goalPath(state, 'goal2Id'), body: { is_active: false } }),
    reread: (state) => ['/api/goals', `/api/goals/${state.goal2Id ?? 'none'}`],
  },
  {
    name: 'update a missing goal',
    endpoint: 'PATCH /api/goals/{goal_id}',
    prepare: () => ({ method: 'PATCH', path: `/api/goals/${MISSING}`, body: { name: 'Parity' } }),
    reread: () => [],
  },
  {
    name: 'generate suggestions for a missing goal',
    endpoint: 'POST /api/goals/{goal_id}/suggestions',
    prepare: () => ({ method: 'POST', path: `/api/goals/${MISSING}/suggestions` }),
    reread: () => [],
  },
  {
    name: 'keep a suggestion',
    endpoint: 'PATCH /api/suggestions/{suggestion_id}',
    prepare: (_api, state) => ({
      method: 'PATCH',
      path: `/api/suggestions/${need(state, 'suggestion2Id')}`,
      body: { status: 'kept' },
    }),
    reread: (state) => [`/api/goals/${state.goalId ?? 'none'}/suggestions`],
  },
  {
    name: 'update a missing suggestion',
    endpoint: 'PATCH /api/suggestions/{suggestion_id}',
    prepare: () => ({ method: 'PATCH', path: `/api/suggestions/${MISSING}`, body: { status: 'kept' } }),
    reread: () => [],
  },
  {
    name: 'reject an invalid suggestion status',
    endpoint: 'PATCH /api/suggestions/{suggestion_id}',
    prepare: (_api, state) => ({
      method: 'PATCH',
      path: `/api/suggestions/${need(state, 'suggestionId')}`,
      body: { status: 'archived' },
    }),
    reread: () => [],
  },
  {
    name: 'create a goal with no body',
    endpoint: 'POST /api/goals',
    prepare: () => ({ method: 'POST', path: '/api/goals' }),
    reread: () => [],
  },
  {
    name: 'use a method the endpoint lacks',
    endpoint: 'PUT /api/goals',
    prepare: () => ({ method: 'PUT', path: '/api/goals', body: { name: 'Parity' } }),
    reread: () => [],
  },
]

const CATEGORY_BODY: Obj = { primary: 'FOOD_AND_DRINK', label: 'Parity snacks', description: 'Made by the parity harness' }
const CATEGORIES = ['/api/categories', '/api/categories?include_hidden=true']

export const CATEGORY_EDGES: readonly WriteStep[] = [
  {
    name: 'create a duplicate category',
    endpoint: 'POST /api/categories',
    prepare: () => ({ method: 'POST', path: '/api/categories', body: CATEGORY_BODY }),
    reread: () => [],
  },
  {
    name: 'create a category without letters',
    endpoint: 'POST /api/categories',
    prepare: () => ({ method: 'POST', path: '/api/categories', body: { primary: '!!!', label: '???' } }),
    reread: () => [],
  },
  {
    name: 'rename a category',
    endpoint: 'PATCH /api/categories/{category_id}',
    prepare: (_api, state) => ({
      method: 'PATCH',
      path: `/api/categories/${need(state, 'categoryId')}`,
      body: { label: 'Parity treats', is_hidden: false },
    }),
    reread: () => CATEGORIES,
  },
  {
    name: 'rename a category to spaces',
    endpoint: 'PATCH /api/categories/{category_id}',
    prepare: (_api, state) => ({
      method: 'PATCH',
      path: `/api/categories/${need(state, 'categoryId')}`,
      body: { label: '   ' },
    }),
    reread: () => CATEGORIES,
  },
  {
    name: 'rename a seeded category',
    endpoint: 'PATCH /api/categories/{category_id}',
    async prepare(api) {
      const restaurant = await category(api, 'FOOD_AND_DRINK_RESTAURANT')
      return { method: 'PATCH', path: `/api/categories/${restaurant.id}`, body: { label: 'Restaurants (parity)' } }
    },
    reread: (_s, today) => [
      ...CATEGORIES,
      `/api/reports/by-category?month=${month(today)}`,
      `/api/reports/month/${month(today)}`,
    ],
  },
  {
    name: 'update a missing category',
    endpoint: 'PATCH /api/categories/{category_id}',
    prepare: () => ({ method: 'PATCH', path: `/api/categories/${MISSING}`, body: { label: 'Parity' } }),
    reread: () => [],
  },
  {
    name: 'reject an invalid category',
    endpoint: 'POST /api/categories',
    prepare: () => ({ method: 'POST', path: '/api/categories', body: { primary: '', label: 'x'.repeat(101) } }),
    reread: () => [],
  },
  {
    name: 'delete a missing rule',
    endpoint: 'DELETE /api/rules/{rule_id}',
    prepare: () => ({ method: 'DELETE', path: `/api/rules/${MISSING}` }),
    reread: () => [],
  },
  {
    name: 'dismiss an unknown change key',
    endpoint: 'POST /api/reports/changes/dismiss',
    prepare: () => ({ method: 'POST', path: '/api/reports/changes/dismiss', body: { key: 'S1:parity:unknown' } }),
    reread: () => CHANGES,
  },
  {
    name: 'reject an empty change key',
    endpoint: 'POST /api/reports/changes/dismiss',
    prepare: () => ({ method: 'POST', path: '/api/reports/changes/dismiss', body: { key: '' } }),
    reread: () => [],
  },
]

/**
 * No body and no Content-Type, on ids that exist. FastAPI answers 422 at `body` before the
 * handler runs, even where every field is optional; the re-read shows anything a write did.
 */
function noBody(name: string, endpoint: string, path: (state: State) => string, reread: string[]): WriteStep {
  const method = endpoint.split(' ')[0] as StepRequest['method']
  return { name, endpoint, prepare: (_api, state) => ({ method, path: path(state) }), reread: () => reread }
}

const NO_BODY_EDGES: WriteStep[] = [
  noBody('create a category with no body', 'POST /api/categories', () => '/api/categories', CATEGORIES),
  noBody(
    'update a category with no body',
    'PATCH /api/categories/{category_id}',
    (state) => `/api/categories/${need(state, 'categoryId')}`,
    CATEGORIES,
  ),
  noBody('update a goal with no body', 'PATCH /api/goals/{goal_id}', (state) => `/api/goals/${need(state, 'goalId')}`, [
    '/api/goals',
  ]),
  noBody(
    'update a suggestion with no body',
    'PATCH /api/suggestions/{suggestion_id}',
    (state) => `/api/suggestions/${need(state, 'suggestionId')}`,
    [],
  ),
  noBody('create a manual entry with no body', 'POST /api/manual-entries', () => '/api/manual-entries', [
    '/api/manual-entries',
  ]),
  noBody(
    'update a manual entry with no body',
    'PATCH /api/manual-entries/{entry_id}',
    (state) => `/api/manual-entries/${need(state, 'entryId')}`,
    ['/api/manual-entries'],
  ),
  noBody('mark recurring with no body', 'POST /api/recurring', () => '/api/recurring', ['/api/recurring']),
  noBody(
    'update a recurrence with no body',
    'PATCH /api/recurring/{recurring_id}',
    (state) => `/api/recurring/${need(state, 'confirmedId')}`,
    ['/api/recurring'],
  ),
  noBody('dismiss a change with no body', 'POST /api/reports/changes/dismiss', () => '/api/reports/changes/dismiss', [
    '/api/reports/changes?all=true',
  ]),
  noBody('connect SimpleFIN with no body', 'POST /api/settings/simplefin', () => '/api/settings/simplefin', [
    '/api/settings/simplefin',
  ]),
]

export const WRITE_STEPS: readonly WriteStep[] = [
  {
    name: 'recategorize with save-as-rule',
    endpoint: 'PATCH /api/transactions/{transaction_id}',
    async prepare(api, state) {
      const txs = await getList(api, TX_ALL, 'items')
      const tx = pick(txs, 'LLM- or rule-categorized outflow with a merchant key', (t) => {
        const c = t.categorization
        return (
          typeof t.merchant_key === 'string' &&
          t.is_transfer === false &&
          isOutflow(t) &&
          isObj(c) &&
          (c.source === 'llm' || c.source === 'rule')
        )
      })
      const categories = await getList(api, '/api/categories')
      const current = isObj(tx.categorization) ? tx.categorization.category_id : null
      const restaurant = pick(categories, 'FOOD_AND_DRINK_RESTAURANT category', (c) => c.detailed === 'FOOD_AND_DRINK_RESTAURANT')
      const target =
        restaurant.id === current
          ? pick(categories, 'FOOD_AND_DRINK_FAST_FOOD category', (c) => c.detailed === 'FOOD_AND_DRINK_FAST_FOOD')
          : restaurant
      state.recategorizedId = tx.id ?? null
      return {
        method: 'PATCH',
        path: `/api/transactions/${tx.id}`,
        body: { category_id: target.id ?? null, essentiality: 'discretionary', save_as_rule: true, rule_match_type: 'exact' },
      }
    },
    reread: (_s, today) => [
      TX_ALL,
      REVIEW,
      '/api/rules',
      `/api/reports/by-category?month=${month(today)}`,
      `/api/reports/month/${month(today)}`,
      '/api/reports/monthly',
      '/api/reports/changes?all=true',
    ],
  },
  {
    name: 'add a note',
    endpoint: 'PATCH /api/transactions/{transaction_id}',
    async prepare(api, state) {
      const txs = await getList(api, REVIEW, 'items')
      const tx = pick(txs, 'transaction needing review', (t) => t.id !== state.recategorizedId)
      state.notedId = tx.id ?? null
      return { method: 'PATCH', path: `/api/transactions/${tx.id}`, body: { note: 'Parity: split with a friend' } }
    },
    reread: () => ['/api/transactions?limit=50', '/api/transactions?q=split&limit=500', REVIEW],
  },
  {
    name: 'mark one-time',
    endpoint: 'PATCH /api/transactions/{transaction_id}',
    async prepare(api, _state, today) {
      // On a month's first days there may be no expense yet; then take last month's largest.
      const largest: Obj[] = []
      for (const m of [month(today), monthOffset(today, -1)]) {
        const detail = await getJson(api, `/api/reports/month/${m}`)
        largest.push(...(isObj(detail) && Array.isArray(detail.largest) ? detail.largest.filter(isObj) : []))
        if (largest.length > 0) break
      }
      const tx = pick(largest, 'largest expense this month or last', () => true)
      return { method: 'PATCH', path: `/api/transactions/${tx.id}`, body: { one_time: true } }
    },
    reread: (_s, today) => [
      '/api/projection',
      '/api/projection?months=6',
      `/api/reports/month/${month(today)}`,
      `/api/transactions?start=${month(today)}-01&end=${today}&limit=500`,
      '/api/reports/changes?all=true',
    ],
  },
  {
    name: 'confirm a recurrence',
    endpoint: 'PATCH /api/recurring/{recurring_id}',
    async prepare(api, state) {
      const charge = pick(await getList(api, '/api/recurring?status=proposed'), 'proposed recurrence', () => true)
      state.confirmedId = charge.id ?? null
      return { method: 'PATCH', path: `/api/recurring/${charge.id}`, body: { status: 'confirmed' } }
    },
    reread: () => ['/api/recurring', '/api/recurring?status=confirmed', '/api/projection', '/api/reports/changes?all=true'],
  },
  {
    name: 'dismiss a recurrence',
    endpoint: 'PATCH /api/recurring/{recurring_id}',
    async prepare(api, state) {
      const proposed = await getList(api, '/api/recurring?status=proposed')
      const charge = pick(proposed, 'second proposed recurrence', (c) => c.id !== state.confirmedId)
      state.dismissedKey = charge.merchant_key ?? null
      return { method: 'PATCH', path: `/api/recurring/${charge.id}`, body: { status: 'dismissed' } }
    },
    reread: () => ['/api/recurring', '/api/recurring?status=dismissed', '/api/projection', '/api/reports/changes?all=true'],
  },
  {
    name: 'mark a merchant yearly recurring',
    endpoint: 'POST /api/recurring',
    async prepare(api) {
      const recurring = new Set((await getList(api, '/api/recurring')).map((c) => c.merchant_key))
      const txs = await getList(api, TX_ALL, 'items')
      const tx = pick(
        txs,
        'outflow whose merchant is not recurring',
        (t) => typeof t.merchant_key === 'string' && t.is_transfer === false && isOutflow(t) && !recurring.has(t.merchant_key),
      )
      return { method: 'POST', path: '/api/recurring', body: { transaction_id: tx.id ?? null, cadence: 'yearly' } }
    },
    reread: () => ['/api/recurring', '/api/projection?months=12'],
  },
  {
    name: 'create a manual entry',
    endpoint: 'POST /api/manual-entries',
    prepare: (_api, _state, today) => ({
      method: 'POST',
      path: '/api/manual-entries',
      body: { amount: '-180.00', description: 'Parity car registration', due_date: addDays(today, 14), recurrence: 'none' },
    }),
    capture: captureId('entryId'),
    reread: () => ['/api/manual-entries', '/api/projection', '/api/reports/changes?all=true'],
  },
  {
    name: 'create a recurring manual entry',
    endpoint: 'POST /api/manual-entries',
    prepare: (_api, _state, today) => ({
      method: 'POST',
      path: '/api/manual-entries',
      body: {
        amount: '250.00',
        description: 'Parity side income',
        category_id: null,
        due_date: addDays(today, 5),
        recurrence: 'monthly',
        end_date: addDays(today, 120),
      },
    }),
    capture: captureId('recurringEntryId'),
    reread: () => ['/api/manual-entries', '/api/projection', '/api/projection?months=6'],
  },
  {
    name: 'update a manual entry',
    endpoint: 'PATCH /api/manual-entries/{entry_id}',
    prepare: (_api, state, today) => ({
      method: 'PATCH',
      path: `/api/manual-entries/${need(state, 'entryId')}`,
      body: { amount: '-200.00', due_date: addDays(today, 20) },
    }),
    reread: () => ['/api/manual-entries', '/api/projection'],
  },
  {
    name: 'delete a manual entry',
    endpoint: 'DELETE /api/manual-entries/{entry_id}',
    prepare: (_api, state) => ({ method: 'DELETE', path: `/api/manual-entries/${need(state, 'recurringEntryId')}` }),
    reread: () => ['/api/manual-entries', '/api/projection'],
  },
  {
    name: 'create a goal',
    endpoint: 'POST /api/goals',
    prepare: (_api, _state, today) => ({
      method: 'POST',
      path: '/api/goals',
      body: { name: 'Parity emergency fund', target_amount: '6000.00', target_date: addDays(today, 365) },
    }),
    capture: captureId('goalId'),
    reread: (state) => ['/api/goals', ...(state.goalId == null ? [] : [`/api/goals/${state.goalId}`])],
  },
  {
    name: 'reject a goal dated today',
    endpoint: 'POST /api/goals',
    prepare: (_api, _state, today) => ({
      method: 'POST',
      path: '/api/goals',
      body: { name: 'Parity past goal', target_amount: '100.00', target_date: today },
    }),
    reread: () => ['/api/goals'],
  },
  {
    name: 'reject an invalid goal body',
    endpoint: 'POST /api/goals',
    prepare: () => ({
      method: 'POST',
      path: '/api/goals',
      body: { name: '', target_amount: '-5', target_date: 'soon', colour: 'blue' },
    }),
    reread: () => ['/api/goals'],
  },
  {
    name: 'update a goal',
    endpoint: 'PATCH /api/goals/{goal_id}',
    prepare: (_api, state) => ({
      method: 'PATCH',
      path: `/api/goals/${need(state, 'goalId')}`,
      body: { target_amount: '7500.00' },
    }),
    reread: (state) => ['/api/goals', `/api/goals/${state.goalId ?? "none"}`],
  },
  {
    name: 'generate suggestions',
    endpoint: 'POST /api/goals/{goal_id}/suggestions',
    prepare: (_api, state) => ({ method: 'POST', path: `/api/goals/${need(state, 'goalId')}/suggestions` }),
    capture: captureId('suggestionId'),
    reread: (state) => [`/api/goals/${state.goalId ?? "none"}/suggestions`],
  },
  {
    name: 'dismiss a suggestion',
    endpoint: 'PATCH /api/suggestions/{suggestion_id}',
    prepare: (_api, state) => ({
      method: 'PATCH',
      path: `/api/suggestions/${need(state, 'suggestionId')}`,
      body: { status: 'dismissed' },
    }),
    reread: (state) => [`/api/goals/${state.goalId ?? "none"}/suggestions`],
  },
  {
    name: 'generate suggestions again',
    endpoint: 'POST /api/goals/{goal_id}/suggestions',
    prepare: (_api, state) => ({ method: 'POST', path: `/api/goals/${need(state, 'goalId')}/suggestions` }),
    capture: captureId('suggestion2Id'),
    reread: (state) => [`/api/goals/${state.goalId ?? "none"}/suggestions`],
  },
  {
    name: 'dismiss a change',
    endpoint: 'POST /api/reports/changes/dismiss',
    async prepare(api) {
      const item = pick(await getList(api, '/api/reports/changes?all=true', 'items'), 'change item', () => true)
      return { method: 'POST', path: '/api/reports/changes/dismiss', body: { key: item.key ?? null } }
    },
    reread: () => CHANGES,
  },
  {
    name: 'clear change dismissals',
    endpoint: 'DELETE /api/reports/changes/dismissals',
    prepare: () => ({ method: 'DELETE', path: '/api/reports/changes/dismissals' }),
    reread: () => CHANGES,
  },
  {
    name: 'create a category',
    endpoint: 'POST /api/categories',
    prepare: () => ({
      method: 'POST',
      path: '/api/categories',
      body: CATEGORY_BODY,
    }),
    capture: captureId('categoryId'),
    reread: () => ['/api/categories', '/api/categories?include_hidden=true'],
  },
  {
    name: 'hide a category',
    endpoint: 'PATCH /api/categories/{category_id}',
    prepare: (_api, state) => ({
      method: 'PATCH',
      path: `/api/categories/${need(state, 'categoryId')}`,
      body: { is_hidden: true },
    }),
    reread: () => ['/api/categories', '/api/categories?include_hidden=true'],
  },
  {
    name: 'delete a rule',
    endpoint: 'DELETE /api/rules/{rule_id}',
    async prepare(api) {
      const rule = pick(await getList(api, '/api/rules'), 'rule', () => true)
      return { method: 'DELETE', path: `/api/rules/${rule.id}` }
    },
    reread: () => ['/api/rules', TX_ALL],
  },
  {
    name: 'start a sync without a connection',
    endpoint: 'POST /api/sync',
    prepare: () => ({ method: 'POST', path: '/api/sync' }),
    reread: () => ['/api/sync/runs'],
  },
  {
    name: 'disconnect SimpleFIN',
    endpoint: 'DELETE /api/settings/simplefin',
    prepare: () => ({ method: 'DELETE', path: '/api/settings/simplefin' }),
    reread: () => ['/api/settings/simplefin'],
  },
  {
    name: 'update a missing transaction',
    endpoint: 'PATCH /api/transactions/{transaction_id}',
    prepare: () => ({ method: 'PATCH', path: '/api/transactions/999999', body: { note: 'Parity' } }),
    reread: () => [],
  },
  ...TRANSACTION_EDGES,
  ...RECURRING_EDGES,
  ...MANUAL_ENTRY_EDGES,
  ...GOAL_EDGES,
  ...CATEGORY_EDGES,
  ...NO_BODY_EDGES,
]

/** Prepare a step; any failure becomes a PrepareError. */
export async function runPrepare(step: WriteStep, api: Api, state: State, today: string): Promise<StepRequest> {
  try {
    return await step.prepare(api, state, today)
  } catch (err) {
    if (err instanceof PrepareError) throw err
    throw new PrepareError(err instanceof Error ? err.message : String(err))
  }
}
