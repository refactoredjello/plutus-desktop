/**
 * Category and rule routes. The LLM status test lives in settings_routes.test.ts, with the
 * settings routes it exercises.
 */

import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Db } from '../src/db/index.js'
import { type Confidence, categories, categorizations, merchantClassifications, rules } from '../src/db/schema.js'
import { utcNow } from '../src/lib/dates.js'
import { type Transaction, categoryId, makeAccount, makeTx } from './factories.js'
import { makeApp } from './setup.js'

type Body = Record<string, unknown>

function send(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
}

describe('categories', () => {
  it('hides hidden categories by default', async () => {
    const { app, db } = makeApp()
    const all = (await (await app.request('/api/categories')).json()) as Body[]
    expect(all.length).toBeGreaterThanOrEqual(127)
    expect(new Set(Object.keys(all[0] as Body))).toEqual(
      new Set(['id', 'primary', 'detailed', 'label', 'description', 'is_hidden', 'is_custom']),
    )
    const coffee = categoryId(db, 'FOOD_AND_DRINK_COFFEE')
    expect((await app.request(`/api/categories/${coffee}`, send('PATCH', { is_hidden: true }))).status).toBe(200)
    const visible = new Set(((await (await app.request('/api/categories')).json()) as Body[]).map((c) => c.id))
    expect(visible.has(coffee)).toBe(false)
    const everything = new Set(
      ((await (await app.request('/api/categories?include_hidden=true')).json()) as Body[]).map((c) => c.id),
    )
    expect(everything.has(coffee)).toBe(true)
  })

  it('creates a custom category', async () => {
    const { app, db } = makeApp()
    const r = await app.request(
      '/api/categories',
      send('POST', { primary: 'FOOD_AND_DRINK', label: 'Meal kits & boxes', description: 'Weekly boxes' }),
    )
    expect(r.status).toBe(201)
    const body = (await r.json()) as Body
    expect(body.detailed).toBe('CUSTOM_MEAL_KITS_BOXES')
    expect([body.primary, body.label, body.is_custom]).toEqual(['FOOD_AND_DRINK', 'Meal kits & boxes', true])
    const rows = db.select().from(categories).where(eq(categories.detailed, 'CUSTOM_MEAL_KITS_BOXES')).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.is_custom).toBe(true)

    const duplicate = await app.request('/api/categories', send('POST', { primary: 'FOOD_AND_DRINK', label: 'meal kits boxes' }))
    expect(duplicate.status).toBe(409)
  })

  it('rejects a category whose slug is empty', async () => {
    const { app } = makeApp()
    expect((await app.request('/api/categories', send('POST', { primary: 'OTHER', label: '!!!' }))).status).toBe(400)
  })

  it('updates a label, and 404s on an unknown category', async () => {
    const { app, db } = makeApp()
    const cat = categoryId(db, 'FOOD_AND_DRINK_COFFEE')
    const r = await app.request(`/api/categories/${cat}`, send('PATCH', { label: 'Cafes' }))
    expect(r.status).toBe(200)
    const body = (await r.json()) as Body
    expect([body.label, body.is_hidden]).toEqual(['Cafes', false])
    expect((await app.request('/api/categories/999999', send('PATCH', { label: 'x' }))).status).toBe(404)
  })

  it('lists and deletes rules', async () => {
    const { app, db } = makeApp()
    const rule = db
      .insert(rules)
      .values({
        match_type: 'prefix',
        pattern: 'UBER',
        category_id: categoryId(db, 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES'),
        essentiality: 'flexible',
      })
      .returning()
      .get()
    const listed = (await (await app.request('/api/rules')).json()) as Body[]
    expect(listed.map((r) => [r.id, r.match_type, r.pattern, r.essentiality])).toEqual([[rule.id, 'prefix', 'UBER', 'flexible']])
    expect((await app.request(`/api/rules/${rule.id}`, send('DELETE'))).status).toBe(204)
    expect(await (await app.request('/api/rules')).json()).toEqual([])
    expect((await app.request(`/api/rules/${rule.id}`, send('DELETE'))).status).toBe(404)
  })
})

function cache(db: Db, key: string, source: 'manual' | 'llm' = 'manual', confidence: Confidence = 'very_high'): void {
  db.insert(merchantClassifications)
    .values({ merchant_key: key, category_id: categoryId(db, 'OTHER_OTHER'), essentiality: null, confidence, source })
    .run()
}

const cachedKeys = (db: Db): string[] =>
  db
    .select()
    .from(merchantClassifications)
    .all()
    .map((c) => c.merchant_key)
    .sort()

function categorizationOf(db: Db, tx: Transaction) {
  return db.select().from(categorizations).where(eq(categorizations.transaction_id, tx.id)).get()
}

async function createRule(app: ReturnType<typeof makeApp>['app'], body: unknown): Promise<Response> {
  return await app.request('/api/rules', send('POST', body))
}

describe('POST /api/rules (backlog 35)', () => {
  it('creates a rule, applies it to existing transactions, and returns it', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const trip = makeTx(db, acct, '-9.00', 'UBER TRIP 1234', '2026-01-10', { merchant_key: 'UBER TRIP' })
    const eats = makeTx(db, acct, '-9.00', 'UBER EATS 5678', '2026-01-10', { merchant_key: 'UBER EATS' })
    const manual = makeTx(db, acct, '-9.00', 'UBER ONE', '2026-01-10', { merchant_key: 'UBER ONE' })
    db.insert(categorizations)
      .values({
        transaction_id: manual.id,
        category_id: categoryId(db, 'OTHER_OTHER'),
        source: 'manual',
        confidence: 'very_high',
        updated_at: utcNow(),
      })
      .run()
    const cat = categoryId(db, 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES')
    const r = await createRule(app, { match_type: 'prefix', pattern: ' uber ', category_id: cat, essentiality: 'flexible' })
    expect(r.status).toBe(200)
    const body = (await r.json()) as Body
    expect([body.match_type, body.pattern, body.category_id, body.essentiality]).toEqual(['prefix', 'UBER', cat, 'flexible'])
    expect(typeof body.id).toBe('number')
    for (const tx of [trip, eats]) {
      const c = categorizationOf(db, tx)
      expect([c?.category_id, c?.source, c?.essentiality]).toEqual([cat, 'rule', 'flexible'])
    }
    expect(categorizationOf(db, manual)?.category_id).toBe(categoryId(db, 'OTHER_OTHER')) // manual wins
    expect(cachedKeys(db)).toEqual([]) // prefix rules write no cache entry (backlog 16)
  })

  it('upserts by match type and pattern', async () => {
    const { app, db } = makeApp()
    const coffee = categoryId(db, 'FOOD_AND_DRINK_COFFEE')
    const groceries = categoryId(db, 'FOOD_AND_DRINK_GROCERIES')
    const first = (await (await createRule(app, { match_type: 'exact', pattern: 'BLUE BOTTLE', category_id: coffee, essentiality: 'discretionary' })).json()) as Body
    const second = (await (await createRule(app, { match_type: 'exact', pattern: 'blue bottle', category_id: groceries })).json()) as Body
    expect(second.id).toBe(first.id)
    expect([second.category_id, second.essentiality]).toEqual([groceries, null])
    await createRule(app, { match_type: 'contains', pattern: 'blue bottle', category_id: coffee })
    expect(db.select().from(rules).all().map((r) => [r.match_type, r.pattern])).toEqual([
      ['exact', 'BLUE BOTTLE'],
      ['contains', 'blue bottle'],
    ])
  })

  it('an exact rule writes a manual cache entry; a contains rule does not', async () => {
    const { app, db } = makeApp()
    const cat = categoryId(db, 'FOOD_AND_DRINK_COFFEE')
    await createRule(app, { match_type: 'contains', pattern: 'Bottle', category_id: cat })
    expect(cachedKeys(db)).toEqual([])
    await createRule(app, { match_type: 'exact', pattern: 'blue bottle coffee', category_id: cat, essentiality: 'flexible' })
    const entry = db.select().from(merchantClassifications).get()
    expect([entry?.merchant_key, entry?.category_id, entry?.essentiality, entry?.source, entry?.confidence]).toEqual([
      'BLUE BOTTLE COFFEE',
      cat,
      'flexible',
      'manual',
      'very_high',
    ])
  })

  it('a contains rule casefolds against the raw description', async () => {
    const { app, db } = makeApp()
    const tx = makeTx(db, makeAccount(db), '-4.00', 'Markt Stra\u00dfe 9', '2026-01-10', { merchant_key: 'MARKT STRASSE' })
    const cat = categoryId(db, 'FOOD_AND_DRINK_GROCERIES')
    expect((await createRule(app, { match_type: 'contains', pattern: 'STRASSE', category_id: cat })).status).toBe(200)
    expect(categorizationOf(db, tx)?.category_id).toBe(cat)
  })

  it('rejects an unknown category, a blank pattern, and a bad body', async () => {
    const { app, db } = makeApp()
    const cat = categoryId(db, 'FOOD_AND_DRINK_COFFEE')
    expect((await createRule(app, { match_type: 'exact', pattern: 'X', category_id: 999999 })).status).toBe(400)
    expect((await createRule(app, { match_type: 'exact', pattern: '   ', category_id: cat })).status).toBe(400)
    expect((await createRule(app, { match_type: 'exact', pattern: '', category_id: cat })).status).toBe(422)
    expect((await createRule(app, { match_type: 'regex', pattern: 'X', category_id: cat })).status).toBe(422)
    expect((await createRule(app, { match_type: 'exact', pattern: 'X', category_id: cat, extra: 1 })).status).toBe(422)
    expect((await createRule(app, { match_type: 'exact', pattern: 'x'.repeat(201), category_id: cat })).status).toBe(422)
    expect(db.select().from(rules).all()).toEqual([])
  })
})

describe('deleting a rule removes the manual cache rows it created (backlog 15)', () => {
  function insertRule(db: Db, matchType: 'exact' | 'prefix' | 'contains', pattern: string) {
    return db
      .insert(rules)
      .values({ match_type: matchType, pattern, category_id: categoryId(db, 'OTHER_OTHER') })
      .returning()
      .get()
  }

  it('exact: the key', async () => {
    const { app, db } = makeApp()
    const rule = insertRule(db, 'exact', 'NETFLIX')
    cache(db, 'NETFLIX')
    cache(db, 'NETFLIX COM')
    expect((await app.request(`/api/rules/${rule.id}`, send('DELETE'))).status).toBe(204)
    expect(cachedKeys(db)).toEqual(['NETFLIX COM'])
  })

  it('prefix: keys starting with the pattern, manual only, sparing keys another exact rule holds', async () => {
    const { app, db } = makeApp()
    const rule = insertRule(db, 'prefix', 'UBER')
    insertRule(db, 'exact', 'UBER ONE')
    cache(db, 'UBER')
    cache(db, 'UBER TRIP')
    cache(db, 'UBER ONE')
    cache(db, 'UBER EATS', 'llm', 'high')
    cache(db, 'SUPER UBER')
    await app.request(`/api/rules/${rule.id}`, send('DELETE'))
    expect(cachedKeys(db)).toEqual(['SUPER UBER', 'UBER EATS', 'UBER ONE'])
  })

  it('contains: keys of transactions the pattern matches, and the pattern itself', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    makeTx(db, acct, '-4.00', 'SQ *Blue Bottle 1234', '2026-01-10', { merchant_key: 'BLUE BOTTLE' })
    makeTx(db, acct, '-4.00', 'RITUAL', '2026-01-10', { merchant_key: 'RITUAL' })
    const rule = insertRule(db, 'contains', 'BLUE BOTTLE COFFEE')
    const legacy = insertRule(db, 'contains', 'bottle')
    cache(db, 'BLUE BOTTLE COFFEE')
    cache(db, 'BLUE BOTTLE')
    cache(db, 'RITUAL')
    await app.request(`/api/rules/${rule.id}`, send('DELETE'))
    expect(cachedKeys(db)).toEqual(['BLUE BOTTLE', 'RITUAL']) // the pattern's own legacy row
    await app.request(`/api/rules/${legacy.id}`, send('DELETE'))
    expect(cachedKeys(db)).toEqual(['RITUAL'])
  })
})
