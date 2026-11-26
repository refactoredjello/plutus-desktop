/**
 * The transaction panel's rule endpoints: GET /api/transactions/{id}/rule finds the rule that
 * categorization would pick (same precedence), or suggests one; POST /api/rules/preview counts
 * what a rule would match, as applyRule selects it. Both are read-only and never call an LLM.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/db/index.js'
import { type ClassificationSource, type RuleMatchType, categorizations, rules } from '../src/db/schema.js'
import { utcNow } from '../src/lib/dates.js'
import { ClaudeProvider } from '../src/providers/llm/claude.js'
import { FakeLLMProvider } from '../src/providers/llm/fake.js'
import { OllamaProvider } from '../src/providers/llm/ollama.js'
import { merchantKey } from '../src/services/scrub.js'
import { type Transaction, categoryId, makeAccount, makeTx } from './factories.js'
import { makeApp } from './setup.js'

type Body = Record<string, unknown>
type App = ReturnType<typeof makeApp>['app']

function addRule(db: Db, match_type: RuleMatchType, pattern: string, detailed = 'OTHER_OTHER') {
  return db.insert(rules).values({ match_type, pattern, category_id: categoryId(db, detailed), essentiality: null }).returning().get()
}

function categorize(db: Db, tx: Transaction, source: ClassificationSource, detailed = 'OTHER_OTHER'): void {
  db.insert(categorizations)
    .values({
      transaction_id: tx.id,
      category_id: categoryId(db, detailed),
      essentiality: 'flexible',
      source,
      confidence: 'very_high',
      updated_at: utcNow(),
    })
    .run()
}

async function lookup(app: App, id: number): Promise<Body> {
  const r = await app.request(`/api/transactions/${id}/rule`)
  expect(r.status).toBe(200)
  return (await r.json()) as Body
}

async function preview(app: App, body: unknown): Promise<Response> {
  return await app.request('/api/rules/preview', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('GET /api/transactions/{id}/rule', () => {
  it('returns the exact rule over contains and prefix rules', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-9.00', 'UBER EATS 5678 SF', '2026-01-10', { merchant_key: 'UBER EATS' })
    addRule(db, 'prefix', 'UBER')
    addRule(db, 'contains', 'eats')
    const exact = addRule(db, 'exact', 'UBER EATS')
    expect(((await lookup(app, tx.id)).rule as Body).id).toBe(exact.id)
  })

  it('prefers contains over prefix, and the longest contains pattern', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-9.00', 'UBER EATS 5678 SF', '2026-01-10', { merchant_key: 'UBER EATS' })
    addRule(db, 'prefix', 'UBER EATS')
    addRule(db, 'contains', 'eats')
    const longer = addRule(db, 'contains', 'Uber Eats 5678')
    expect(((await lookup(app, tx.id)).rule as Body).id).toBe(longer.id)
  })

  it('matches contains rules with full case folding', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-9.00', 'STRASSE CAFE BERLIN', '2026-01-10', { merchant_key: 'STRASSE CAFE' })
    const rule = addRule(db, 'contains', 'straße')
    expect(((await lookup(app, tx.id)).rule as Body).id).toBe(rule.id)
  })

  it('returns no rule and suggests one from the merchant key and current category', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-5.00', 'SQ *BLUE BOTTLE COFFEE 1234', '2026-01-10', {
      merchant_key: 'BLUE BOTTLE COFFEE',
      payee: 'Blue Bottle Coffee',
    })
    categorize(db, tx, 'llm', 'FOOD_AND_DRINK_COFFEE')
    addRule(db, 'exact', 'SOMETHING ELSE')
    expect(await lookup(app, tx.id)).toEqual({
      rule: null,
      suggestion: {
        match_type: 'exact',
        pattern: 'BLUE BOTTLE COFFEE',
        contains_pattern: 'Blue Bottle Coffee',
        category_id: categoryId(db, 'FOOD_AND_DRINK_COFFEE'),
        essentiality: 'flexible',
      },
    })
  })

  it('suggests the raw description for contains when it does not contain the payee', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-5.00', 'POS 88213 SQ', '2026-01-10', { merchant_key: 'POS SQ', payee: 'Square' })
    const body = await lookup(app, tx.id)
    expect(body.suggestion).toEqual({
      match_type: 'exact',
      pattern: 'POS SQ',
      contains_pattern: 'POS 88213 SQ',
      category_id: null,
      essentiality: null,
    })
  })

  it('derives the merchant key when the transaction has none yet', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-5.00', 'NETFLIX.COM 866-579-7172 CA')
    const key = merchantKey(tx.raw_description, [])
    expect(key).not.toBe('')
    const rule = addRule(db, 'exact', key)
    const body = await lookup(app, tx.id)
    expect((body.rule as Body).id).toBe(rule.id)
    expect((body.suggestion as Body).pattern).toBe(key)
  })

  it('finds no rule for a transfer, since rules never categorize transfers', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-500.00', 'TRANSFER TO SAVINGS', '2026-01-10', {
      merchant_key: 'TRANSFER TO SAVINGS',
      is_transfer: true,
    })
    addRule(db, 'exact', 'TRANSFER TO SAVINGS')
    expect((await lookup(app, tx.id)).rule).toBeNull()
  })

  it('404s for an unknown transaction', async () => {
    const { app } = makeApp()
    expect((await app.request('/api/transactions/999/rule')).status).toBe(404)
  })
})

describe('POST /api/rules/preview', () => {
  it('counts non-transfer matches and how many are manual', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const ruled = makeTx(db, acct, '-9.00', 'UBER TRIP 1', '2026-01-10', { merchant_key: 'UBER TRIP' })
    const manual = makeTx(db, acct, '-9.00', 'UBER TRIP 2', '2026-01-11', { merchant_key: 'UBER TRIP' })
    makeTx(db, acct, '-9.00', 'UBER TRIP 3', '2026-01-12', { merchant_key: 'UBER TRIP' })
    makeTx(db, acct, '-9.00', 'UBER TRIP 4', '2026-01-12', { merchant_key: 'UBER TRIP', is_transfer: true })
    makeTx(db, acct, '-9.00', 'UBER EATS', '2026-01-12', { merchant_key: 'UBER EATS' })
    categorize(db, ruled, 'rule')
    categorize(db, manual, 'manual')
    const r = await preview(app, { match_type: 'exact', pattern: ' uber  trip ' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ matches: 3, manual: 1 })
  })

  it('matches prefix rules on the merchant key, case-sensitively after normalizing', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    makeTx(db, acct, '-9.00', 'UBER TRIP', '2026-01-10', { merchant_key: 'UBER TRIP' })
    makeTx(db, acct, '-9.00', 'UBER EATS', '2026-01-10', { merchant_key: 'UBER EATS' })
    makeTx(db, acct, '-9.00', 'LYFT', '2026-01-10', { merchant_key: 'LYFT' })
    expect(await (await preview(app, { match_type: 'prefix', pattern: 'uber' })).json()).toEqual({ matches: 2, manual: 0 })
  })

  it('matches contains rules on the raw description with full case folding', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    makeTx(db, acct, '-9.00', 'STRASSE CAFE BERLIN', '2026-01-10', { merchant_key: 'STRASSE CAFE' })
    makeTx(db, acct, '-9.00', 'Straße Bakery', '2026-01-10', { merchant_key: 'STRASSE BAKERY' })
    makeTx(db, acct, '-9.00', 'OTHER', '2026-01-10', { merchant_key: 'OTHER' })
    expect(await (await preview(app, { match_type: 'contains', pattern: 'strasse' })).json()).toEqual({
      matches: 2,
      manual: 0,
    })
  })

  it('writes nothing', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    makeTx(db, acct, '-9.00', 'UBER TRIP', '2026-01-10', { merchant_key: 'UBER TRIP' })
    await preview(app, { match_type: 'exact', pattern: 'UBER TRIP' })
    expect(db.select().from(categorizations).all()).toEqual([])
    expect(db.select().from(rules).all()).toEqual([])
  })

  it('rejects an empty pattern', async () => {
    const { app } = makeApp()
    expect((await preview(app, { match_type: 'exact', pattern: '   ' })).status).toBe(400)
  })
})

describe('privacy', () => {
  afterEach(() => vi.restoreAllMocks())

  it('neither endpoint calls an LLM', async () => {
    const refuse = () => {
      throw new Error('The rule lookup and preview must not call an LLM provider')
    }
    const spies = [FakeLLMProvider, ClaudeProvider, OllamaProvider].flatMap((cls) => [
      vi.spyOn(cls.prototype, 'classifyMerchants').mockImplementation(refuse),
      vi.spyOn(cls.prototype, 'suggestSavings').mockImplementation(refuse),
    ])
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-5.00', 'NEVER SEEN MERCHANT 99')
    expect((await app.request(`/api/transactions/${tx.id}/rule`)).status).toBe(200)
    expect((await preview(app, { match_type: 'contains', pattern: 'never seen' })).status).toBe(200)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})
