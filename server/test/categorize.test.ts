/**
 * The categorization pipeline and rules, including the privacy tests: nothing sensitive
 * reaches the provider, notes never reach the LLM, and transfers get transfer categories
 * without the LLM.
 *
 * The owner tokens and the LLM knobs come from the config service, so the call takes the
 * secret store and the config defaults that seed it. The last block pins case folding:
 * contains rules use full case folding everywhere; transaction search uses simple lowercase.
 */

import { count, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeDefaults } from '../src/config.js'
import type { Db } from '../src/db/index.js'
import {
  type Confidence,
  type Essentiality,
  type RuleMatchType,
  categories,
  categorizations,
  merchantClassifications,
  rules,
  transactions,
} from '../src/db/schema.js'
import { utcNow } from '../src/lib/dates.js'
import { classifyUserMessage } from '../src/providers/llm/prompts.js'
import { FakeLLMProvider } from '../src/providers/llm/fake.js'
import type { LLMProvider, MerchantClassification, MerchantInput, SavingsSuggestion } from '../src/providers/llm/types.js'
import { KeySecretStore } from '../src/secrets.js'
import { applyRule, casefold, categorizePending, simpleLower } from '../src/services/categorize.js'
import { matchTransfers } from '../src/services/transfers.js'
import { type Transaction, categoryId, loadSimplefinFixture, makeAccount, makeTx, settingsWithOwner } from './factories.js'
import { makeDb, testConfig } from './setup.js'

type Categorization = typeof categorizations.$inferSelect
type Rule = typeof rules.$inferSelect

let db: Db
const secrets = new KeySecretStore(testConfig().secretKey)

beforeEach(() => {
  db = makeDb()
})

/** categorize_pending(db, settings_with_owner(), provider). */
function categorize(provider?: LLMProvider, defaults: RuntimeDefaults = settingsWithOwner().defaults): Promise<number> {
  return categorizePending(db, secrets, defaults, provider)
}

/** db.refresh(tx). */
function reload(tx: Transaction): Transaction {
  const row = db.select().from(transactions).where(eq(transactions.id, tx.id)).get()
  if (row === undefined) throw new Error(`Transaction ${tx.id} is gone`)
  return row
}

function categorizationOf(tx: Transaction): Categorization | undefined {
  return db.select().from(categorizations).where(eq(categorizations.transaction_id, tx.id)).get()
}

/** _cat: the transaction's categorization, which must exist. */
function cat(tx: Transaction): Categorization {
  const c = categorizationOf(tx)
  expect(c).toBeDefined()
  return c as Categorization
}

/** _detailed. */
function detailed(c: Categorization): string {
  const row = db.select({ detailed: categories.detailed }).from(categories).where(eq(categories.id, c.category_id)).get()
  if (row === undefined) throw new Error(`No category ${c.category_id}`)
  return row.detailed
}

function setCategorization(tx: Transaction, detailedName: string, source: Categorization['source'], confidence: Confidence): void {
  db.insert(categorizations)
    .values({
      transaction_id: tx.id,
      category_id: categoryId(db, detailedName),
      source,
      confidence,
      updated_at: utcNow(),
    })
    .run()
}

function cachedEntry(key: string) {
  return db.select().from(merchantClassifications).where(eq(merchantClassifications.merchant_key, key)).get()
}

class ExplodingProvider implements LLMProvider {
  readonly name = 'boom'
  calls = 0

  async classifyMerchants(): Promise<MerchantClassification[]> {
    this.calls += 1
    throw new Error('provider down')
  }

  async suggestSavings(): Promise<SavingsSuggestion[]> {
    throw new Error('provider down')
  }
}

/** Answers with a category that does not exist. */
class OddProvider implements LLMProvider {
  readonly name = 'odd'

  async classifyMerchants(items: readonly MerchantInput[]): Promise<MerchantClassification[]> {
    return items.map((i) => ({
      merchant_key: i.merchant_key,
      detailed_category: 'NOT_A_CATEGORY',
      essentiality: 'essential' as const,
      confidence: 'very_high' as const,
    }))
  }

  async suggestSavings(): Promise<SavingsSuggestion[]> {
    return []
  }
}

/** Four or more digits in a row, in any script. */
const LONG_DIGITS = /\p{Nd}{4,}/u

describe('categorizePending', () => {
  it('privacy: nothing sensitive reaches the provider', async () => {
    const loaded = loadSimplefinFixture(db)
    const llm = new FakeLLMProvider()
    matchTransfers(db)
    await categorize(llm)

    expect(llm.classifyCalls.length).toBeGreaterThan(0)
    const sent = llm.classifyCalls.flat()
    expect(sent.length).toBeGreaterThan(0)
    const payloads = [...sent.map((item) => item.merchant_key), ...llm.classifyCalls.map((call) => classifyUserMessage(call))]
    for (const payload of payloads) {
      expect(LONG_DIGITS.test(payload), payload).toBe(false)
      const upper = payload.toUpperCase()
      for (const forbidden of ['ALEX', 'SAMPLE', 'JANE', 'DOE']) {
        expect(upper.includes(forbidden), `${forbidden} in ${payload}`).toBe(false)
      }
    }
    // descriptions that scrub to themselves (e.g. PLANET FITNESS CLUB FEES) are already clean
    const txs = loaded.map(reload)
    const rawDescriptions = new Set(txs.filter((t) => t.raw_description !== t.merchant_key).map((t) => t.raw_description))
    expect(rawDescriptions.size).toBeGreaterThan(0)
    for (const payload of payloads) {
      for (const raw of rawDescriptions) expect(payload.includes(raw), `${raw} in ${payload}`).toBe(false)
    }
    for (const item of sent) expect(LONG_DIGITS.test(item.merchant_key)).toBe(false)
    // Only the four scrubbed fields are ever sent.
    for (const item of sent) {
      expect(Object.keys(item).sort()).toEqual(['account_kind', 'amount_bucket', 'direction', 'merchant_key'])
    }
    expect(new Set(sent.map((i) => i.merchant_key)).size).toBe(sent.length) // deduplicated
  })

  it('categorizes every fixture transaction', async () => {
    const loaded = loadSimplefinFixture(db)
    matchTransfers(db)
    const n = await categorize(new FakeLLMProvider())
    expect(n).toBe(loaded.length)
    for (const t of loaded) {
      cat(t)
      expect(reload(t).merchant_key).toBeTruthy()
    }
    expect(await categorize(new FakeLLMProvider())).toBe(0)
  })

  it('gives transfers transfer categories without the LLM', async () => {
    const chk = makeAccount(db, 'checking')
    const sav = makeAccount(db, 'savings')
    const cc = makeAccount(db, 'credit')
    const toSav = makeTx(db, chk, '-500.00', 'ONLINE TRANSFER TO SAV', '2026-01-05')
    const fromChk = makeTx(db, sav, '500.00', 'ONLINE TRANSFER FROM CHK', '2026-01-05')
    const pay = makeTx(db, chk, '-90.00', 'PAYMENT TO CARD', '2026-01-06')
    const received = makeTx(db, cc, '90.00', 'AUTOMATIC PAYMENT', '2026-01-07')
    const llm = new FakeLLMProvider()
    matchTransfers(db)
    await categorize(llm)

    expect(llm.classifyCalls).toEqual([])
    const expected: [Transaction, string][] = [
      [toSav, 'TRANSFER_OUT_SAVINGS'],
      [fromChk, 'TRANSFER_IN_SAVINGS'],
      [pay, 'TRANSFER_OUT_ACCOUNT_TRANSFER'],
      [received, 'TRANSFER_IN_ACCOUNT_TRANSFER'],
    ]
    for (const [tx, name] of expected) {
      const c = cat(tx)
      expect(detailed(c)).toBe(name)
      expect(c.source).toBe('rule')
    }
  })

  it('rules beat cache beat LLM', async () => {
    const acct = makeAccount(db)
    const ruled = makeTx(db, acct, '-5.00', 'BLUE BOTTLE COFFEE 1234')
    const cached = makeTx(db, acct, '-5.00', 'NETFLIX.COM')
    const fresh = makeTx(db, acct, '-5.00', 'SOME RESTAURANT')
    db.insert(rules)
      .values({
        match_type: 'exact',
        pattern: 'BLUE BOTTLE COFFEE',
        category_id: categoryId(db, 'FOOD_AND_DRINK_GROCERIES'),
        essentiality: 'essential',
      })
      .run()
    db.insert(merchantClassifications)
      .values([
        {
          merchant_key: 'BLUE BOTTLE COFFEE',
          category_id: categoryId(db, 'FOOD_AND_DRINK_COFFEE'),
          essentiality: 'discretionary',
          confidence: 'high',
          source: 'llm',
        },
        {
          merchant_key: 'NETFLIX.COM',
          category_id: categoryId(db, 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES'),
          essentiality: 'flexible',
          confidence: 'medium',
          source: 'llm',
        },
      ])
      .run()
    const llm = new FakeLLMProvider()
    await categorize(llm)

    const r = cat(ruled)
    const c = cat(cached)
    const f = cat(fresh)
    expect([detailed(r), r.source, r.confidence]).toEqual(['FOOD_AND_DRINK_GROCERIES', 'rule', 'very_high'])
    expect(r.essentiality).toBe('essential')
    // the cache entry wins over what the fake LLM would say for NETFLIX
    expect(detailed(c)).toBe('GENERAL_SERVICES_OTHER_GENERAL_SERVICES')
    expect([c.source, c.confidence]).toEqual(['cache', 'medium'])
    expect([detailed(f), f.source]).toEqual(['FOOD_AND_DRINK_RESTAURANT', 'llm'])
    expect(llm.classifyCalls.flat().map((i) => i.merchant_key)).toEqual(['SOME RESTAURANT'])
  })

  it('prefix rules: the longest wins, and exact beats prefix', async () => {
    const acct = makeAccount(db)
    const a = makeTx(db, acct, '-5.00', 'UBER TRIP HELP')
    const b = makeTx(db, acct, '-5.00', 'UBER EATS')
    const c = makeTx(db, acct, '-5.00', 'UBER EATS')
    db.insert(rules)
      .values([
        { match_type: 'prefix', pattern: 'UBER', category_id: categoryId(db, 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES') },
        { match_type: 'prefix', pattern: 'UBER EATS', category_id: categoryId(db, 'FOOD_AND_DRINK_RESTAURANT') },
      ])
      .run()
    await categorize(new FakeLLMProvider())
    expect(detailed(cat(a))).toBe('TRANSPORTATION_TAXIS_AND_RIDE_SHARES')
    expect(detailed(cat(b))).toBe('FOOD_AND_DRINK_RESTAURANT')
    expect(detailed(cat(c))).toBe('FOOD_AND_DRINK_RESTAURANT')
  })

  it('the cache prevents repeat LLM calls', async () => {
    const acct = makeAccount(db)
    const first = makeTx(db, acct, '-4.00', 'SQ *BLUE BOTTLE COFFEE 1111')
    const llm = new FakeLLMProvider()
    await categorize(llm)
    expect(llm.classifyCalls).toHaveLength(1)
    expect(cat(first).source).toBe('llm')
    const entry = cachedEntry('BLUE BOTTLE COFFEE')
    expect(entry).toBeDefined()
    expect(entry?.source).toBe('llm')

    const second = makeTx(db, acct, '-4.50', 'SQ *BLUE BOTTLE COFFEE 2222')
    await categorize(llm)
    expect(llm.classifyCalls).toHaveLength(1)
    expect(cat(second).source).toBe('cache')
  })

  it('sends duplicate keys in one run once', async () => {
    const acct = makeAccount(db)
    for (let n = 0; n < 5; n++) makeTx(db, acct, '-4.00', `SQ *BLUE BOTTLE COFFEE ${1000 + n}`)
    const llm = new FakeLLMProvider()
    expect(await categorize(llm)).toBe(5)
    expect(llm.classifyCalls.map((c) => c.length)).toEqual([1])
  })

  it('batches LLM calls at fifty', async () => {
    const acct = makeAccount(db)
    for (let n = 0; n < 120; n++) {
      const key = `${'ABCDEFGHIJ'[n % 10]}${'KLMNOPQRST'[Math.floor(n / 10) % 10]}${'UVWXYZ'[Math.floor(n / 100)]}`
      makeTx(db, acct, '-4.00', `MERCHANT ${key}`)
    }
    const llm = new FakeLLMProvider()
    await categorize(llm)
    expect(llm.classifyCalls.map((c) => c.length)).toEqual([50, 50, 20])
  })

  it('an LLM failure leaves transactions uncategorized and does not throw', async () => {
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-4.00', 'MYSTERY SHOP')
    const provider = new ExplodingProvider()
    expect(await categorize(provider)).toBe(0)
    expect(provider.calls).toBe(1)
    expect(categorizationOf(tx)).toBeUndefined()
    expect(reload(tx).merchant_key).toBe('MYSTERY SHOP')
    expect(db.select({ n: count() }).from(merchantClassifications).get()?.n).toBe(0)
    // Next sync retries and succeeds.
    expect(await categorize(new FakeLLMProvider())).toBe(1)
  })

  it('missing provider config does not throw', async () => {
    const acct = makeAccount(db)
    makeTx(db, acct, '-4.00', 'MYSTERY SHOP')
    const defaults: RuntimeDefaults = { ...testConfig().defaults, llmProvider: 'claude', anthropicApiKey: null }
    expect(await categorizePending(db, secrets, defaults)).toBe(0)
  })

  it('an unknown LLM category falls back to OTHER_OTHER with low confidence', async () => {
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-4.00', 'MYSTERY SHOP')
    await categorize(new OddProvider())
    const c = cat(tx)
    expect(detailed(c)).toBe('OTHER_OTHER')
    expect(c.confidence).toBe('low')
    const entry = cachedEntry('MYSTERY SHOP')
    expect(entry).toBeDefined()
    expect(entry?.confidence).toBe('low')
  })

  it('leaves already categorized transactions alone', async () => {
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-4.00', 'NETFLIX.COM')
    setCategorization(tx, 'OTHER_OTHER', 'manual', 'very_high')
    const llm = new FakeLLMProvider()
    expect(await categorize(llm)).toBe(0)
    expect(llm.classifyCalls).toEqual([])
  })
})

/** _rule. */
function rule(matchType: RuleMatchType, pattern: string, detailedName: string, essentiality: Essentiality | null = 'flexible'): Rule {
  return db
    .insert(rules)
    .values({ match_type: matchType, pattern, category_id: categoryId(db, detailedName), essentiality })
    .returning()
    .get()
}

describe('rules', () => {
  it('precedence is exact, then contains, then prefix', async () => {
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-5.00', 'ACME COFFEE SHOP 123')
    rule('prefix', 'ACME', 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE')
    rule('contains', 'coffee', 'FOOD_AND_DRINK_COFFEE')
    const llm = new FakeLLMProvider()
    await categorize(llm)
    const c = cat(tx)
    expect(detailed(c)).toBe('FOOD_AND_DRINK_COFFEE')
    expect([c.source, c.confidence]).toEqual(['rule', 'very_high'])
    expect(llm.classifyCalls).toEqual([])

    const tx2 = makeTx(db, acct, '-5.00', 'ACME COFFEE SHOP 123')
    expect(tx2.merchant_key).toBeNull()
    rule('exact', 'ACME COFFEE SHOP 123', 'FOOD_AND_DRINK_RESTAURANT')
    await categorize(llm)
    expect(detailed(cat(tx2))).toBe('FOOD_AND_DRINK_RESTAURANT')
  })

  it('contains: the longest pattern wins, case-insensitively', async () => {
    const tx = makeTx(db, makeAccount(db), '-5.00', 'Whole Foods Market Cafe')
    rule('contains', 'FOODS', 'FOOD_AND_DRINK_GROCERIES')
    rule('contains', 'whole foods market', 'FOOD_AND_DRINK_RESTAURANT')
    const llm = new FakeLLMProvider()
    await categorize(llm)
    expect(detailed(cat(tx))).toBe('FOOD_AND_DRINK_RESTAURANT')
    expect(llm.classifyCalls).toEqual([])
  })

  it('contains matches the raw description, not the scrubbed key', async () => {
    const tx = makeTx(db, makeAccount(db), '-5.00', 'SQ *BLUE BOTTLE 4821 OAKLAND')
    rule('contains', '4821', 'FOOD_AND_DRINK_COFFEE')
    await categorize(new FakeLLMProvider())
    expect(detailed(cat(tx))).toBe('FOOD_AND_DRINK_COFFEE')
  })

  it('apply_rule respects manual categorizations and transfers', () => {
    const acct = makeAccount(db)
    const plain = makeTx(db, acct, '-5.00', 'Corner Coffee')
    const fresh = makeTx(db, acct, '-6.00', 'COFFEE BAR')
    const manual = makeTx(db, acct, '-7.00', 'My coffee')
    const transfer = makeTx(db, acct, '-8.00', 'coffee transfer', '2026-01-10', { is_transfer: true })
    const other = makeTx(db, acct, '-9.00', 'Gas station')
    setCategorization(plain, 'OTHER_OTHER', 'llm', 'low')
    setCategorization(manual, 'OTHER_OTHER', 'manual', 'low')
    const r = rule('contains', 'coffee', 'FOOD_AND_DRINK_COFFEE')

    expect(applyRule(db, r)).toBe(2)
    for (const tx of [plain, fresh]) {
      const c = cat(tx)
      expect(detailed(c)).toBe('FOOD_AND_DRINK_COFFEE')
      expect([c.source, c.confidence]).toEqual(['rule', 'very_high'])
      expect(c.essentiality).toBe('flexible')
    }
    expect(cat(manual).source).toBe('manual')
    expect(categorizationOf(transfer)).toBeUndefined()
    expect(categorizationOf(other)).toBeUndefined()
  })

  it('notes never reach the LLM', async () => {
    const acct = makeAccount(db)
    const secret = 'zxqnote therapy sessions'
    makeTx(db, acct, '-120.00', 'SOME CLINIC 1234', '2026-01-10', { note: secret })
    makeTx(db, acct, '-12.00', 'NETFLIX.COM CA', '2026-01-10', { note: secret })
    const llm = new FakeLLMProvider()
    await categorize(llm)
    expect(llm.classifyCalls.length).toBeGreaterThan(0)
    for (const call of llm.classifyCalls) {
      const blob = JSON.stringify(call) + classifyUserMessage(call)
      expect(blob).not.toContain('zxqnote')
      expect(blob.toLowerCase()).not.toContain('therapy')
    }
  })
})

describe('case folding', () => {
  it('casefold is full Unicode case folding', () => {
    expect(casefold('Stra\u00dfe')).toBe('strasse')
    expect(casefold('STRA\u1e9eE')).toBe('strasse') // capital sharp s
    expect(casefold('\u03a3\u039f\u03a3')).toBe('\u03c3\u03bf\u03c3') // no final-sigma context
    expect(casefold('\u0131')).toBe('\u0131') // dotless i stays
    expect(casefold('\u0130')).toBe('i\u0307')
    expect(casefold('\u212a')).toBe('k') // Kelvin sign
    expect(casefold('\uab70\u13a0')).toBe('\u13a0\u13a0') // Cherokee folds to uppercase
    expect(casefold('\ufb03')).toBe('ffi')
  })

  it('simpleLower is the simple lowercase mapping, one code point at a time', () => {
    expect(simpleLower('CAF\u00c9')).toBe('caf\u00e9')
    expect(simpleLower('\u0130STANBUL')).toBe('istanbul')
    expect(simpleLower('\u039f\u0394\u039f\u03a3')).toBe('\u03bf\u03b4\u03bf\u03c3')
    expect(simpleLower('\u1e9e')).toBe('\u00df') // no expansion to ss
    expect(simpleLower('\u13a0')).toBe('\uab70')
    expect(simpleLower('\u24b6')).toBe('\u24b6') // circled letters are left alone
  })

  it('contains rules casefold the same way in categorization and in applyRule (backlog 18)', async () => {
    const acct = makeAccount(db)
    const existing = makeTx(db, acct, '-5.00', 'Gro\u00dfmarkt Stra\u00dfe')
    const r = rule('contains', 'STRASSE', 'FOOD_AND_DRINK_GROCERIES')
    expect(applyRule(db, r)).toBe(1) // casefold('...Stra\u00dfe') contains 'strasse'
    expect(detailed(cat(existing))).toBe('FOOD_AND_DRINK_GROCERIES')
    const fresh = makeTx(db, acct, '-6.00', 'Markt Stra\u00dfe 9')
    await categorize(new FakeLLMProvider())
    expect(detailed(cat(fresh))).toBe('FOOD_AND_DRINK_GROCERIES')

    const cafe = makeTx(db, acct, '-4.00', 'CAF\u00c9 NOIR')
    const accented = rule('contains', 'caf\u00e9', 'FOOD_AND_DRINK_COFFEE')
    expect(applyRule(db, accented)).toBe(1) // SQLite's ASCII lower() would miss this
    expect(detailed(cat(cafe))).toBe('FOOD_AND_DRINK_COFFEE')
  })

  it('apply_rule: prefix is case-sensitive and literal, as LIKE with autoescape was', () => {
    const acct = makeAccount(db)
    const upper = makeTx(db, acct, '-5.00', 'x', '2026-01-10', { merchant_key: 'UBER_EATS%' })
    const lower = makeTx(db, acct, '-5.00', 'x', '2026-01-10', { merchant_key: 'uber_eats%' })
    const wild = makeTx(db, acct, '-5.00', 'x', '2026-01-10', { merchant_key: 'UBERXEATS' })
    expect(applyRule(db, rule('prefix', 'UBER_', 'FOOD_AND_DRINK_RESTAURANT'))).toBe(1)
    expect(categorizationOf(upper)).toBeDefined()
    expect(categorizationOf(lower)).toBeUndefined()
    expect(categorizationOf(wild)).toBeUndefined()
  })
})
