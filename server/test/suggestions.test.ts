/**
 * Savings suggestions, plus a pin on the savings user message for a known database state.
 *
 * The route looks its provider up through `suggestionsLlm.get`, which the tests replace.
 */

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/db/index.js'
import {
  type Essentiality,
  balanceSnapshots,
  categories,
  categorizations,
  goals,
  merchantClassifications,
  recurrences,
  suggestions,
} from '../src/db/schema.js'
import { plainDate, utcNow } from '../src/lib/dates.js'
import { ProviderError } from '../src/lib/errors.js'
import { cents, parseMoney } from '../src/lib/money.js'
import { FakeLLMProvider } from '../src/providers/llm/fake.js'
import { savingsUserMessage } from '../src/providers/llm/prompts.js'
import type { LLMProvider, SavingsContext, SavingsSuggestion } from '../src/providers/llm/types.js'
import { suggestionsLlm } from '../src/routes/goals.js'
import { buildContext } from '../src/services/suggestions.js'
import { categoryId, makeAccount, makeTx } from './factories.js'
import { makeApp } from './setup.js'

const TODAY = '2026-10-15'
const NETFLIX_KEY = 'NETFLIX.COM CA'

type Row = { id: number; [key: string]: unknown }

let ctx: ReturnType<typeof makeApp>
let db: Db
let llm: FakeLLMProvider

function useProvider(provider: LLMProvider): void {
  vi.spyOn(suggestionsLlm, 'get').mockReturnValue(provider)
}

beforeEach(() => {
  vi.stubEnv('PLUTUS_TODAY', TODAY) // frozen_today
  ctx = makeApp()
  db = ctx.db
  llm = new FakeLLMProvider() // the llm fixture
  useProvider(llm)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
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

function provider(suggest: (context: SavingsContext) => SavingsSuggestion[]): LLMProvider {
  return {
    name: 'test',
    classifyMerchants: async () => {
      throw new Error('classify must not be called')
    },
    suggestSavings: async (context) => suggest(context),
  }
}

function categorize(txId: number, detailed: string, ess: Essentiality | null = null): void {
  db.insert(categorizations)
    .values({
      transaction_id: txId,
      category_id: categoryId(db, detailed),
      essentiality: ess,
      source: 'manual',
      updated_at: utcNow(),
    })
    .run()
}

function label(detailed: string): string {
  const row = db.select({ label: categories.label }).from(categories).where(eq(categories.detailed, detailed)).get()
  if (row === undefined) throw new Error(`no category ${detailed}`)
  return row.label
}

async function makeGoal(): Promise<number> {
  const body = { name: 'Emergency fund', target_amount: '5000', target_date: '2027-04-15' }
  return Number(((await call('POST', '/api/goals', body)).json as Row).id)
}

/** Flatten a context to text; money is replaced so digit runs can be checked. */
function walk(context: SavingsContext): string {
  const parts: string[] = ['AMOUNT', String(context.months_left), 'AMOUNT']
  for (const c of context.categories) parts.push(c.label, ...c.monthly_totals.map(() => 'AMOUNT'))
  for (const r of context.recurring) parts.push(r.category_label, 'AMOUNT', r.cadence, r.essentiality)
  parts.push(...context.excluded_suggestions)
  return parts.join(' ')
}

describe('suggestions', () => {
  it('generates, stores, and lists newest first', async () => {
    const gid = await makeGoal()
    const r = await call('POST', `/api/goals/${gid}/suggestions`)
    expect(r.status).toBe(201)
    const created = r.json as Row[]
    expect(created.map((s) => s.text)).toEqual(['Set a weekly cap on dining out.'])
    expect(created[0]?.status).toBe('open')
    expect(created[0]?.estimated_monthly_saving).toBe('50.00')
    expect(llm.suggestCalls).toHaveLength(1)

    useProvider(provider(() => [{ text: 'Cancel gym', category_label: null, estimated_monthly_saving: null }]))
    await call('POST', `/api/goals/${gid}/suggestions`)
    const texts = ((await call('GET', `/api/goals/${gid}/suggestions`)).json as Row[]).map((s) => s.text)
    expect(texts).toEqual(['Cancel gym', 'Set a weekly cap on dining out.'])
  })

  it('resolves the category by exact label', async () => {
    const coffee = label('FOOD_AND_DRINK_COFFEE')
    useProvider(
      provider(() => [
        { text: 'Fewer lattes', category_label: coffee, estimated_monthly_saving: cents(2000) },
        { text: 'Mystery', category_label: 'No Such Label', estimated_monthly_saving: null },
      ]),
    )
    const gid = await makeGoal()
    const out = (await call('POST', `/api/goals/${gid}/suggestions`)).json as Row[]
    expect(out[0]?.category_id).not.toBeNull()
    expect(out[1]?.category_id).toBeNull()
  })

  it('passes dismissed suggestions as exclusions', async () => {
    const gid = await makeGoal()
    const first = ((await call('POST', `/api/goals/${gid}/suggestions`)).json as Row[])[0] as Row
    expect(llm.suggestCalls[0]?.excluded_suggestions).toEqual([])
    await call('PATCH', `/api/suggestions/${first.id}`, { status: 'kept' })
    await call('POST', `/api/goals/${gid}/suggestions`)
    expect(llm.suggestCalls[1]?.excluded_suggestions).toEqual([])
    const r = await call('PATCH', `/api/suggestions/${first.id}`, { status: 'dismissed' })
    expect((r.json as Row).status).toBe('dismissed')
    await call('POST', `/api/goals/${gid}/suggestions`)
    expect(llm.suggestCalls[2]?.excluded_suggestions).toEqual([first.text])
    const other = await makeGoal()
    await call('POST', `/api/goals/${other}/suggestions`)
    expect(llm.suggestCalls[3]?.excluded_suggestions).toEqual([])
    expect(db.select().from(suggestions).where(eq(suggestions.id, first.id)).get()).toBeDefined()
  })

  it('surfaces a provider failure as 502 and stores nothing', async () => {
    useProvider(
      provider(() => {
        throw new ProviderError('down')
      }),
    )
    const gid = await makeGoal()
    const r = await call('POST', `/api/goals/${gid}/suggestions`)
    expect(r.status).toBe(502)
    expect(db.select().from(suggestions).all()).toEqual([])
  })

  it('answers 404s', async () => {
    expect((await call('POST', '/api/goals/999999/suggestions')).status).toBe(404)
    expect((await call('GET', '/api/goals/999999/suggestions')).status).toBe(404)
    const r = await call('PATCH', '/api/suggestions/999999', { status: 'kept' })
    expect(r.status).toBe(404)
  })

  it('builds the context from aggregates only', async () => {
    const acct = makeAccount(db, 'checking', 'Jane Q Public Checking 12345678')
    db.insert(balanceSnapshots).values({ account_id: acct.id, balance: parseMoney('98765.43'), as_of: utcNow() }).run()
    const descNetflix = 'NETFLIX.COM CA 408-540-3700 REF 998877665544'
    const descCoffee = 'SQ *BLUE BOTTLE COFFEE #4412 SAN FRANCISCO'
    const descRent = 'ZELLE TO LANDLORD JOHN SMITH 20260905'
    for (const month of [5, 6, 7, 8, 9]) {
      const mm = String(month).padStart(2, '0')
      const nf = makeTx(db, acct, '-15.49', descNetflix, `2026-${mm}-03`, { merchant_key: NETFLIX_KEY })
      categorize(nf.id, 'ENTERTAINMENT_TV_AND_MOVIES', 'discretionary')
      const cf = makeTx(db, acct, '-6.25', descCoffee, `2026-${mm}-09`, { merchant_key: 'BLUE BOTTLE COFFEE' })
      categorize(cf.id, 'FOOD_AND_DRINK_COFFEE', 'discretionary')
      const rt = makeTx(db, acct, '-1800', descRent, `2026-${mm}-01`, { merchant_key: 'ZELLE TO' })
      categorize(rt.id, 'RENT_AND_UTILITIES_RENT', 'essential')
    }
    // Current (incomplete) month must not appear in the history.
    makeTx(db, acct, '-999', 'CURRENT MONTH SPEND', '2026-10-02')
    const recurring = (key: string, amount: string, status: 'confirmed' | 'proposed', ess: Essentiality, nxt: string) =>
      db.insert(recurrences)
        .values({
          merchant_key: key,
          account_id: acct.id,
          amount: parseMoney(amount),
          cadence: 'monthly',
          next_expected_date: plainDate(nxt),
          status,
          essentiality: ess,
        })
        .run()
    recurring(NETFLIX_KEY, '-15.49', 'confirmed', 'discretionary', '2026-11-03')
    // Proposed and essential charges are excluded.
    recurring('SECRET PROPOSED', '-9.99', 'proposed', 'discretionary', '2026-11-03')
    recurring('LANDLORD ESSENTIAL', '-1800', 'confirmed', 'essential', '2026-11-01')

    const gid = await makeGoal()
    expect((await call('POST', `/api/goals/${gid}/suggestions`)).status).toBe(201)
    const context = llm.suggestCalls.at(-1) as SavingsContext

    expect(context.recurring).toHaveLength(1)
    const rec = context.recurring[0]
    expect(rec?.category_label).toBe(label('ENTERTAINMENT_TV_AND_MOVIES'))
    expect(rec?.amount).toBe(parseMoney('15.49'))
    expect(rec?.cadence).toBe('monthly')
    expect(context.categories.every((c) => c.monthly_totals.length === 6)).toBe(true)
    const rent = context.categories.find((c) => c.monthly_totals.at(-1) === parseMoney('1800.00'))
    expect(rent?.monthly_totals).toEqual([0, ...Array(5).fill(parseMoney('1800.00'))])
    expect(context.categories.every((c) => !c.monthly_totals.includes(parseMoney('999')))).toBe(true)

    const text = walk(context).toLowerCase()
    for (const forbidden of [
      NETFLIX_KEY,
      'NETFLIX',
      'SECRET PROPOSED',
      'LANDLORD',
      'BLUE BOTTLE',
      'ZELLE',
      'SMITH',
      'Jane',
      'Public',
      'Checking',
      '408-540-3700',
      'CURRENT MONTH',
    ]) {
      expect(text).not.toContain(forbidden.toLowerCase())
    }
    expect(text).not.toMatch(/\d{4,}/)
    expect(JSON.stringify(context)).not.toContain('98765')
  })

  it('never puts notes in the suggestion context', async () => {
    const acct = makeAccount(db)
    for (const month of [5, 6, 7, 8, 9]) {
      const tx = makeTx(db, acct, '-15.49', 'NETFLIX.COM CA', `2026-0${month}-03`, {
        merchant_key: NETFLIX_KEY,
        note: 'zxqnote shared with my sister',
      })
      categorize(tx.id, 'ENTERTAINMENT_TV_AND_MOVIES', 'discretionary')
    }
    const gid = await makeGoal()
    expect((await call('POST', `/api/goals/${gid}/suggestions`)).status).toBe(201)
    expect(llm.suggestCalls.length).toBeGreaterThan(0)
    const blob = JSON.stringify(llm.suggestCalls)
    expect(blob).not.toContain('zxqnote')
    expect(blob).not.toContain('sister')
  })
})

describe('the savings user message', () => {
  it('is byte-identical to the pinned message for the same data', async () => {
    const acct = makeAccount(db)
    const snapshot = (balance: string, asOf: string) =>
      db.insert(balanceSnapshots).values({ account_id: acct.id, balance: parseMoney(balance), as_of: asOf }).run()
    snapshot('1234.56', '2026-10-01T00:00:00.000Z')
    const gid = await makeGoal()
    snapshot('1500.00', '2026-10-02T00:00:00.000Z')
    const tx = (amount: string, posted: string, key: string, detailed?: string, ess?: Essentiality) => {
      const row = makeTx(db, acct, amount, key, posted, { merchant_key: key })
      if (detailed !== undefined) categorize(row.id, detailed, ess ?? null)
    }
    for (const month of [5, 6, 7, 8, 9]) {
      const mm = String(month).padStart(2, '0')
      tx('-15.49', `2026-${mm}-03`, NETFLIX_KEY, 'ENTERTAINMENT_TV_AND_MOVIES', 'discretionary')
      tx('-6.25', `2026-${mm}-09`, 'BLUE BOTTLE COFFEE', 'FOOD_AND_DRINK_COFFEE', 'discretionary')
      tx('-1800', `2026-${mm}-01`, 'ZELLE TO', 'RENT_AND_UTILITIES_RENT', 'essential')
    }
    for (const month of [7, 8, 9]) tx('2500.00', `2026-0${month}-15`, 'ACME PAYROLL')
    tx('-3.33', '2026-09-20', 'BLUE BOTTLE COFFEE', 'FOOD_AND_DRINK_COFFEE', 'discretionary')
    db.insert(merchantClassifications)
      .values({
        merchant_key: 'GYM CLUB',
        category_id: categoryId(db, 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS'),
        essentiality: 'flexible',
        confidence: 'high',
        source: 'llm',
      })
      .run()
    const charge = (key: string, amount: string, cadence: 'monthly' | 'yearly' | 'weekly', nxt: string, ess: Essentiality) =>
      db.insert(recurrences)
        .values({
          merchant_key: key,
          account_id: acct.id,
          amount: parseMoney(amount),
          cadence,
          next_expected_date: plainDate(nxt),
          status: 'confirmed',
          essentiality: ess,
        })
        .run()
    charge(NETFLIX_KEY, '-15.49', 'monthly', '2026-11-03', 'discretionary')
    charge('GYM CLUB', '-120.00', 'yearly', '2027-01-05', 'flexible')
    charge('MYSTERY', '-7.00', 'weekly', '2026-10-20', 'discretionary')
    const suggestion = (text: string, status: 'dismissed' | 'kept') =>
      db.insert(suggestions).values({ goal_id: gid, text, status }).run()
    suggestion('Cancel streaming.', 'dismissed')
    suggestion('Keep this one.', 'kept')
    suggestion('Skip the "fancy" coffee.', 'dismissed')

    const goal = db.select().from(goals).where(eq(goals.id, gid)).get()
    if (goal === undefined) throw new Error('no goal')
    expect(savingsUserMessage(buildContext(db, goal))).toBe(PYTHON_MESSAGE)
  })
})

// savingsUserMessage(buildContext(db, goal)) over the same rows, pinned.
const PYTHON_MESSAGE =
  'Suggest savings for this situation:\n' +
  '{\n' +
  ' "goal_target": "5000.00",\n' +
  ' "months_left": 6,\n' +
  ' "monthly_gap": "111.94",\n' +
  ' "categories": [\n' +
  '  {\n' +
  '   "label": "Rent",\n' +
  '   "monthly_totals": [\n' +
  '    "0.00",\n' +
  '    "1800.00",\n' +
  '    "1800.00",\n' +
  '    "1800.00",\n' +
  '    "1800.00",\n' +
  '    "1800.00"\n' +
  '   ]\n' +
  '  },\n' +
  '  {\n' +
  '   "label": "TV and movies",\n' +
  '   "monthly_totals": [\n' +
  '    "0.00",\n' +
  '    "15.49",\n' +
  '    "15.49",\n' +
  '    "15.49",\n' +
  '    "15.49",\n' +
  '    "15.49"\n' +
  '   ]\n' +
  '  },\n' +
  '  {\n' +
  '   "label": "Coffee",\n' +
  '   "monthly_totals": [\n' +
  '    "0.00",\n' +
  '    "6.25",\n' +
  '    "6.25",\n' +
  '    "6.25",\n' +
  '    "6.25",\n' +
  '    "9.58"\n' +
  '   ]\n' +
  '  }\n' +
  ' ],\n' +
  ' "recurring": [\n' +
  '  {\n' +
  '   "category_label": "TV and movies",\n' +
  '   "amount": "15.49",\n' +
  '   "cadence": "monthly",\n' +
  '   "essentiality": "discretionary"\n' +
  '  },\n' +
  '  {\n' +
  '   "category_label": "Gyms and fitness centers",\n' +
  '   "amount": "120.00",\n' +
  '   "cadence": "yearly",\n' +
  '   "essentiality": "flexible"\n' +
  '  },\n' +
  '  {\n' +
  '   "category_label": "Uncategorized",\n' +
  '   "amount": "7.00",\n' +
  '   "cadence": "weekly",\n' +
  '   "essentiality": "discretionary"\n' +
  '  }\n' +
  ' ],\n' +
  ' "excluded_suggestions": [\n' +
  '  "Cancel streaming.",\n' +
  '  "Skip the \\"fancy\\" coffee."\n' +
  ' ]\n' +
  '}'
