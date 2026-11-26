/**
 * POST /api/recalculate: re-apply rules, categorize from the merchant cache, and detect
 * recurring charges, all locally. No bank provider and no LLM.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/db/index.js'
import {
  type ClassificationSource,
  type Confidence,
  type Essentiality,
  type RuleMatchType,
  categories,
  categorizations,
  merchantClassifications,
  recurrences,
  rules,
  transactions,
} from '../src/db/schema.js'
import { utcNow } from '../src/lib/dates.js'
import { ClaudeProvider } from '../src/providers/llm/claude.js'
import { FakeLLMProvider } from '../src/providers/llm/fake.js'
import { OllamaProvider } from '../src/providers/llm/ollama.js'
import { KeySecretStore } from '../src/secrets.js'
import { categorizePending } from '../src/services/categorize.js'
import { recalculate } from '../src/services/recalculate.js'
import { merchantKey } from '../src/services/scrub.js'
import { type Transaction, categoryId, makeAccount, makeTx } from './factories.js'
import { makeApp, makeDb, testConfig } from './setup.js'

const config = testConfig()
const secrets = new KeySecretStore(config.secretKey)
let db: Db

beforeEach(() => {
  vi.stubEnv('PLUTUS_TODAY', '2026-10-17')
  db = makeDb()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const run = () => recalculate(db, secrets, config.defaults)

function rule(matchType: RuleMatchType, pattern: string, detailed: string, essentiality: Essentiality | null = 'flexible') {
  return db
    .insert(rules)
    .values({ match_type: matchType, pattern, category_id: categoryId(db, detailed), essentiality })
    .returning()
    .get()
}

function setCategorization(
  tx: Transaction,
  detailed: string,
  source: ClassificationSource,
  confidence: Confidence = 'medium',
  essentiality: Essentiality | null = null,
): void {
  db.insert(categorizations)
    .values({
      transaction_id: tx.id,
      category_id: categoryId(db, detailed),
      essentiality,
      source,
      confidence,
      updated_at: '2026-01-01T00:00:00Z',
    })
    .run()
}

function cat(tx: Transaction) {
  return db.select().from(categorizations).where(eq(categorizations.transaction_id, tx.id)).get()
}

function detailedOf(tx: Transaction): string | undefined {
  const c = cat(tx)
  if (c === undefined) return undefined
  return db.select({ d: categories.detailed }).from(categories).where(eq(categories.id, c.category_id)).get()?.d
}

describe('recalculate', () => {
  it('re-applies a rule to an existing non-manual categorization', () => {
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-5.00', 'BLUE BOTTLE 123', '2026-10-01', { merchant_key: 'BLUE BOTTLE 123' })
    setCategorization(tx, 'FOOD_AND_DRINK_RESTAURANT', 'cache')
    rule('contains', 'bottle', 'FOOD_AND_DRINK_COFFEE', 'discretionary')
    const result = run()
    expect(result.recategorized).toBe(1)
    const c = cat(tx)!
    expect(detailedOf(tx)).toBe('FOOD_AND_DRINK_COFFEE')
    expect([c.source, c.confidence, c.essentiality]).toEqual(['rule', 'very_high', 'discretionary'])
  })

  it('never touches a manual categorization', () => {
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-5.00', 'BLUE BOTTLE 123', '2026-10-01', { merchant_key: 'BLUE BOTTLE 123' })
    setCategorization(tx, 'FOOD_AND_DRINK_RESTAURANT', 'manual', 'very_high', 'essential')
    const before = cat(tx)
    rule('contains', 'bottle', 'FOOD_AND_DRINK_COFFEE')
    expect(run().recategorized).toBe(0)
    expect(cat(tx)).toEqual(before)
  })

  it('keeps a categorization no rule matches, such as one from a deleted rule', () => {
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-5.00', 'OLD SHOP', '2026-10-01', { merchant_key: 'OLD SHOP' })
    setCategorization(tx, 'FOOD_AND_DRINK_COFFEE', 'rule', 'very_high')
    const before = cat(tx)
    expect(run().recategorized).toBe(0)
    expect(cat(tx)).toEqual(before)
  })

  it('does not rewrite a row the rule already gives', () => {
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-5.00', 'BLUE BOTTLE 123', '2026-10-01', { merchant_key: 'BLUE BOTTLE 123' })
    setCategorization(tx, 'FOOD_AND_DRINK_COFFEE', 'rule', 'very_high', 'flexible')
    rule('contains', 'bottle', 'FOOD_AND_DRINK_COFFEE', 'flexible')
    expect(run().recategorized).toBe(0)
    expect(cat(tx)?.updated_at).toBe('2026-01-01T00:00:00Z')
  })

  it('leaves transfers alone', () => {
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-100.00', 'TRANSFER TO SAVINGS', '2026-10-01', { is_transfer: true, merchant_key: 'X' })
    setCategorization(tx, 'TRANSFER_OUT_ACCOUNT_TRANSFER', 'rule', 'high')
    rule('contains', 'savings', 'FOOD_AND_DRINK_COFFEE')
    expect(run().recategorized).toBe(0)
    expect(detailedOf(tx)).toBe('TRANSFER_OUT_ACCOUNT_TRANSFER')
  })

  it('assigns exactly what categorizePending would: exact, then contains, then prefix', async () => {
    const acct = makeAccount(db)
    const descriptions = ['ACME COFFEE SHOP 123', 'ACME TEA HOUSE', 'ACME HARDWARE']
    // Already categorized before the rules existed.
    const old = descriptions.map((desc) => {
      const tx = makeTx(db, acct, '-5.00', desc, '2026-10-01')
      setCategorization(tx, 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', 'cache')
      return tx
    })
    rule('prefix', 'ACME', 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE')
    rule('contains', 'tea', 'FOOD_AND_DRINK_COFFEE')
    rule('contains', 'coffee shop', 'FOOD_AND_DRINK_RESTAURANT')
    rule('exact', 'ACME COFFEE SHOP 123', 'FOOD_AND_DRINK_FAST_FOOD')
    // New ones, categorized by the sync pipeline.
    const fresh = descriptions.map((desc) => makeTx(db, acct, '-5.00', desc, '2026-10-02'))
    const llm = new FakeLLMProvider()
    await categorizePending(db, secrets, config.defaults, llm)
    expect(llm.classifyCalls).toEqual([])
    run()
    expect(old.map(detailedOf)).toEqual(fresh.map(detailedOf))
    expect(old.map(detailedOf)).toEqual([
      'FOOD_AND_DRINK_FAST_FOOD',
      'FOOD_AND_DRINK_COFFEE',
      'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE',
    ])
  })

  it('categorizes uncategorized transactions from rules, the cache, and transfers; unseen merchants stay uncategorized', () => {
    const acct = makeAccount(db)
    const cached = makeTx(db, acct, '-12.00', 'CORNER DELI', '2026-10-01')
    const ruled = makeTx(db, acct, '-9.00', 'BLUE BOTTLE 123', '2026-10-01')
    const transfer = makeTx(db, acct, '-50.00', 'MOVE MONEY', '2026-10-01', { is_transfer: true })
    const unseen = makeTx(db, acct, '-3.00', 'NEVER SEEN BEFORE', '2026-10-01')
    db.insert(merchantClassifications)
      .values({
        merchant_key: 'CORNER DELI',
        category_id: categoryId(db, 'FOOD_AND_DRINK_RESTAURANT'),
        essentiality: 'flexible',
        confidence: 'high',
        source: 'llm',
      })
      .run()
    rule('contains', 'bottle', 'FOOD_AND_DRINK_COFFEE')
    const result = run()
    expect(result.categorized).toBe(3)
    expect(detailedOf(cached)).toBe('FOOD_AND_DRINK_RESTAURANT')
    expect([cat(cached)?.source, cat(cached)?.confidence]).toEqual(['cache', 'high'])
    expect(detailedOf(ruled)).toBe('FOOD_AND_DRINK_COFFEE')
    expect(detailedOf(transfer)).toBe('TRANSFER_OUT_ACCOUNT_TRANSFER')
    expect(cat(unseen)).toBeUndefined()
  })

  it('runs recurring detection', () => {
    const acct = makeAccount(db)
    for (const day of ['2026-07-15', '2026-08-15', '2026-09-15']) {
      const tx = makeTx(db, acct, '-15.49', 'NETFLIX', day, { merchant_key: 'NETFLIX' })
      setCategorization(tx, 'ENTERTAINMENT_TV_AND_MOVIES', 'cache')
    }
    expect(run().recurring_changes).toBe(1)
    expect(db.select().from(recurrences).all().map((r) => r.merchant_key)).toEqual(['NETFLIX'])
  })

  it('re-keys a row whose description changed when it posted, so its recurring charge advances', () => {
    // A monthly charge on the 29th; the October row was keyed while pending, when the bank
    // described it differently, and kept that key after posting (the stored data of 0.6.0).
    vi.stubEnv('PLUTUS_TODAY', '2026-11-25')
    const acct = makeAccount(db)
    const posted = 'ACME INSURE *AUTO SPRINGFIELD IL'
    const key = merchantKey(posted)
    for (const day of ['2026-06-29', '2026-07-29', '2026-08-29', '2026-09-29']) {
      setCategorization(makeTx(db, acct, '-90.00', posted, day, { merchant_key: key }), 'GENERAL_SERVICES_INSURANCE', 'cache')
    }
    run()
    const october = makeTx(db, acct, '-95.00', posted, '2026-10-29', {
      merchant_key: merchantKey('ACME INSURE *AUTO SPRINGFIELD USA'),
    })
    setCategorization(october, 'GENERAL_SERVICES_INSURANCE', 'cache')
    run()
    const stored = db.select().from(transactions).where(eq(transactions.id, october.id)).get()
    expect(stored?.merchant_key).toBe(key)
    const charge = db.select().from(recurrences).get()
    expect([charge?.last_seen_on, charge?.next_expected_date]).toEqual(['2026-10-29', '2026-11-29'])
  })

  it('never calls an llm', async () => {
    const refuse = () => {
      throw new Error('Recalculate must not call an LLM provider')
    }
    const spies = [FakeLLMProvider, ClaudeProvider, OllamaProvider].flatMap((cls) => [
      vi.spyOn(cls.prototype, 'classifyMerchants').mockImplementation(refuse),
      vi.spyOn(cls.prototype, 'suggestSavings').mockImplementation(refuse),
    ])
    const { app, db: appDb } = makeApp()
    const acct = makeAccount(appDb)
    makeTx(appDb, acct, '-3.00', 'NEVER SEEN BEFORE', '2026-10-01')
    const r = await app.request('/api/recalculate', { method: 'POST' })
    expect(r.status).toBe(200)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    const source = readFileSync(fileURLToPath(new URL('../src/services/recalculate.ts', import.meta.url)), 'utf8')
    expect(source).not.toContain('providers/llm')
    expect(source).not.toContain('llmProvider')
    expect(source).not.toContain('simplefin')
  })

  it('POST /api/recalculate answers with the counts', async () => {
    const { app, db: appDb } = makeApp()
    const acct = makeAccount(appDb)
    const tx = makeTx(appDb, acct, '-5.00', 'BLUE BOTTLE 123', '2026-10-01', { merchant_key: 'BLUE BOTTLE 123' })
    appDb
      .insert(categorizations)
      .values({ transaction_id: tx.id, category_id: categoryId(appDb, 'FOOD_AND_DRINK_RESTAURANT'), source: 'cache', updated_at: utcNow() })
      .run()
    appDb
      .insert(rules)
      .values({ match_type: 'contains', pattern: 'bottle', category_id: categoryId(appDb, 'FOOD_AND_DRINK_COFFEE') })
      .run()
    const r = await app.request('/api/recalculate', { method: 'POST' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ recategorized: 1, categorized: 0, recurring_changes: 0 })
  })
})
