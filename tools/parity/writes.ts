/**
 * The scripted write sequence, run on both apps in order. Each step picks its target from the
 * app's own responses (so a step never sends one app's ids to the other), sends one write,
 * captures ids later steps need, and names the GETs to re-read afterwards.
 */

import type { Envelope } from './diff.ts'
import { addDays } from './endpoints.ts'
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
      return { method: 'PATCH', path: `/api/transactions/${tx.id}`, body: { note: 'Parity: split with a friend' } }
    },
    reread: () => ['/api/transactions?limit=50', '/api/transactions?q=split&limit=500', REVIEW],
  },
  {
    name: 'mark one-time',
    endpoint: 'PATCH /api/transactions/{transaction_id}',
    async prepare(api, _state, today) {
      const detail = await getJson(api, `/api/reports/month/${month(today)}`)
      const largest = isObj(detail) && Array.isArray(detail.largest) ? detail.largest.filter(isObj) : []
      const tx = pick(largest, 'largest expense this month', () => true)
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
      body: { primary: 'FOOD_AND_DRINK', label: 'Parity snacks', description: 'Made by the parity harness' },
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
