/**
 * The transaction routes. The last block pins which fields count as sent (rule options count
 * only with save_as_rule) and how `q` lowers non-ASCII text.
 */

import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Db } from '../src/db/index.js'
import {
  type ClassificationSource,
  type Confidence,
  type Essentiality,
  categories,
  categorizations,
  merchantClassifications,
  rules,
} from '../src/db/schema.js'
import { utcNow } from '../src/lib/dates.js'
import { type Transaction, categoryId, makeAccount, makeTx } from './factories.js'
import { makeApp } from './setup.js'

type Body = Record<string, unknown>
type Page = { items: Body[]; total: number; limit: number; offset: number }
type App = ReturnType<typeof makeApp>['app']

/** _categorize. */
function categorize(
  db: Db,
  tx: Transaction,
  detailed = 'FOOD_AND_DRINK_COFFEE',
  confidence: Confidence = 'high',
  source: ClassificationSource = 'llm',
  essentiality: Essentiality | null = 'discretionary',
): void {
  db.insert(categorizations)
    .values({
      transaction_id: tx.id,
      category_id: categoryId(db, detailed),
      essentiality,
      source,
      confidence,
      updated_at: utcNow(),
    })
    .run()
}

function categorizationOf(db: Db, tx: Transaction) {
  return db.select().from(categorizations).where(eq(categorizations.transaction_id, tx.id)).get()
}

/** Query params: lists repeat the key, booleans render as "true"/"false". */
function url(params: Record<string, string | number | boolean | (string | number)[]> = {}): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value]) search.append(key, String(v))
  }
  const text = search.toString()
  return text ? `/api/transactions?${text}` : '/api/transactions'
}

async function list(app: App, params: Parameters<typeof url>[0] = {}): Promise<Page> {
  const r = await app.request(url(params))
  expect(r.status).toBe(200)
  return (await r.json()) as Page
}

const ids = (page: Page): number[] => page.items.map((item) => item.id as number)

async function patch(app: App, id: number, body: unknown): Promise<Response> {
  return await app.request(`/api/transactions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

async function patched(app: App, id: number, body: unknown): Promise<Body> {
  const r = await patch(app, id, body)
  expect(r.status).toBe(200)
  return (await r.json()) as Body
}

describe('GET /api/transactions', () => {
  it('lists newest first, with pagination', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const txs = [0, 1, 2, 3, 4].map((n) => makeTx(db, acct, '-1.00', `M ${n}`, `2026-03-0${n + 1}`))
    const sameDayA = makeTx(db, acct, '-2.00', 'SAME DAY A', '2026-03-05')
    const page1 = await list(app, { limit: 2 })
    expect(page1.total).toBe(6)
    expect([page1.limit, page1.offset]).toEqual([2, 0])
    expect(ids(page1)).toEqual([sameDayA.id, txs[4]?.id])
    const page2 = await list(app, { limit: 2, offset: 2 })
    expect(ids(page2)).toEqual([txs[3]?.id, txs[2]?.id])
    expect(page2.total).toBe(6)
    expect((await app.request(url({ limit: 0 }))).status).toBe(422)
  })

  it('reads with the categorization', async () => {
    const { app, db } = makeApp()
    const tx = makeTx(db, makeAccount(db), '-4.25', 'SQ *BLUE BOTTLE 1234')
    categorize(db, tx)
    const item = (await list(app)).items[0] as Body
    const c = item.categorization as Body
    expect(item.amount).toBe('-4.25')
    expect(c.source).toBe('llm')
    expect(c.essentiality).toBe('discretionary')
    expect(c.confidence).toBe('high')
  })

  it('reads the bank memo', async () => {
    const { app, db } = makeApp()
    makeTx(db, makeAccount(db), '-4.25', 'SQ *BLUE BOTTLE 1234', '2026-01-10', { memo: 'Card 1234' })
    expect(((await list(app)).items[0] as Body).memo).toBe('Card 1234')
  })

  it('filters', async () => {
    const { app, db } = makeApp()
    const a = makeAccount(db)
    const b = makeAccount(db)
    const coffee = makeTx(db, a, '-4.00', 'BLUE BOTTLE COFFEE', '2026-01-05', { payee: 'Blue Bottle' })
    const grocery = makeTx(db, b, '-40.00', 'TRADER JOE S', '2026-02-05', { payee: "Trader Joe's" })
    const rent = makeTx(db, b, '-2000.00', 'ZELLE TO', '2026-03-05')
    categorize(db, coffee)
    categorize(db, grocery, 'FOOD_AND_DRINK_GROCERIES', 'high', 'llm', 'essential')
    categorize(db, rent, 'RENT_AND_UTILITIES_RENT', 'low', 'llm', 'essential')

    const found = async (params: Parameters<typeof url>[0]) => new Set(ids(await list(app, params)))

    expect(await found({ q: 'bottle' })).toEqual(new Set([coffee.id])) // case-insensitive, raw description
    expect(await found({ q: "TRADER JOE'S" })).toEqual(new Set([grocery.id])) // payee
    expect(await found({ q: '100%' })).toEqual(new Set()) // wildcard characters are literal
    expect(await found({ start: '2026-02-01', end: '2026-02-28' })).toEqual(new Set([grocery.id]))
    expect(await found({ account_id: a.id })).toEqual(new Set([coffee.id]))
    expect(await found({ account_id: [a.id, b.id] })).toEqual(new Set([coffee.id, grocery.id, rent.id]))
    expect(await found({ category_id: categoryId(db, 'FOOD_AND_DRINK_GROCERIES') })).toEqual(new Set([grocery.id]))
    expect(await found({ essentiality: 'essential' })).toEqual(new Set([grocery.id, rent.id]))
    expect(await found({ needs_review: 'true' })).toEqual(new Set([rent.id]))
  })

  it('needs_review includes uncategorized and unknown confidence', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const none = makeTx(db, acct, '-1.00')
    const unknown = makeTx(db, acct, '-2.00')
    const ok = makeTx(db, acct, '-3.00')
    categorize(db, unknown, 'FOOD_AND_DRINK_COFFEE', 'unknown')
    categorize(db, ok, 'FOOD_AND_DRINK_COFFEE', 'medium')
    const body = await list(app, { needs_review: 'true' })
    expect(new Set(ids(body))).toEqual(new Set([none.id, unknown.id]))
    expect(body.total).toBe(2)
  })

  it('excludes transfers unless asked', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const normal = makeTx(db, acct, '-1.00')
    const transfer = makeTx(db, acct, '-500.00', 'SOME MERCHANT', '2026-01-10', { is_transfer: true })
    expect(ids(await list(app))).toEqual([normal.id])
    const both = await list(app, { include_transfers: 'true' })
    expect(new Set(ids(both))).toEqual(new Set([normal.id, transfer.id]))
    expect(both.total).toBe(2)
  })

  it('filters uncategorized and unset essentiality', async () => {
    const { app, db } = makeApp()
    const chk = makeAccount(db)
    const bare = makeTx(db, chk, '-9.00', 'MYSTERY')
    const noEss = makeTx(db, chk, '-40.00', 'GIFT')
    const cat = db.select().from(categories).where(eq(categories.detailed, 'FOOD_AND_DRINK_COFFEE')).get()
    db.insert(categorizations)
      .values({ transaction_id: noEss.id, category_id: cat?.id as number, essentiality: null, source: 'manual', updated_at: utcNow() })
      .run()
    expect(new Set(ids(await list(app, { uncategorized: true })))).toEqual(new Set([bare.id]))
    expect(new Set(ids(await list(app, { essentiality: 'unset' })))).toEqual(new Set([bare.id, noEss.id]))
  })

  it('q matches the note case-insensitively', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const withNote = makeTx(db, acct, '-4.00', 'AAA', '2026-01-10', { note: 'Birthday Gift' })
    makeTx(db, acct, '-5.00', 'BBB')
    expect(ids(await list(app, { q: 'birthday' }))).toEqual([withNote.id])
  })
})

describe('PATCH /api/transactions/{id}', () => {
  it('overrides manually', async () => {
    const { app, db } = makeApp()
    const tx = makeTx(db, makeAccount(db), '-4.00', 'MYSTERY SHOP')
    categorize(db, tx, 'OTHER_OTHER', 'low')
    const cat = categoryId(db, 'FOOD_AND_DRINK_RESTAURANT')
    const body = await patched(app, tx.id, { category_id: cat, essentiality: 'flexible' })
    expect(body.categorization).toEqual({ category_id: cat, essentiality: 'flexible', source: 'manual', confidence: 'very_high' })
    expect(db.select().from(rules).all()).toEqual([])
  })

  it('changes essentiality only, and clears it', async () => {
    const { app, db } = makeApp()
    const tx = makeTx(db, makeAccount(db), '-4.00')
    categorize(db, tx)
    const cat = categoryId(db, 'FOOD_AND_DRINK_COFFEE')
    let c = (await patched(app, tx.id, { essentiality: 'essential' })).categorization as Body
    expect(c.category_id).toBe(cat)
    expect(c.essentiality).toBe('essential')
    expect(c.source).toBe('manual')
    c = (await patched(app, tx.id, { essentiality: null })).categorization as Body
    expect(c.essentiality).toBeNull()
  })

  it('requires a category for an uncategorized transaction', async () => {
    const { app, db } = makeApp()
    const tx = makeTx(db, makeAccount(db), '-4.00')
    expect((await patch(app, tx.id, { essentiality: 'essential' })).status).toBe(400)
    const body = await patched(app, tx.id, { category_id: categoryId(db, 'OTHER_OTHER') })
    expect((body.categorization as Body).source).toBe('manual')
  })

  it('errors', async () => {
    const { app, db } = makeApp()
    const tx = makeTx(db, makeAccount(db), '-4.00')
    const missing = await patch(app, 999999, { category_id: 1 })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-type')?.startsWith('application/problem+json')).toBe(true)
    expect((await patch(app, tx.id, { category_id: 999999 })).status).toBe(400)
  })

  it('save_as_rule creates a rule and a cache entry, and propagates', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const key = { merchant_key: 'BLUE BOTTLE COFFEE' }
    const target = makeTx(db, acct, '-4.00', 'SQ *BLUE BOTTLE COFFEE 1234', '2026-01-10', key)
    const llmPeer = makeTx(db, acct, '-5.00', 'SQ *BLUE BOTTLE COFFEE 5678', '2026-01-10', key)
    const manualPeer = makeTx(db, acct, '-6.00', 'SQ *BLUE BOTTLE COFFEE 9012', '2026-01-10', key)
    const freshPeer = makeTx(db, acct, '-7.00', 'SQ *BLUE BOTTLE COFFEE 3456', '2026-01-10', key)
    const other = makeTx(db, acct, '-8.00', 'NETFLIX', '2026-01-10', { merchant_key: 'NETFLIX' })
    for (const tx of [target, llmPeer, other]) categorize(db, tx, 'OTHER_OTHER', 'low')
    categorize(db, manualPeer, 'OTHER_OTHER', 'very_high', 'manual')

    const cat = categoryId(db, 'FOOD_AND_DRINK_COFFEE')
    await patched(app, target.id, { category_id: cat, essentiality: 'discretionary', save_as_rule: true })

    const all = db.select().from(rules).all()
    expect(all).toHaveLength(1)
    const rule = all[0]
    expect([rule?.match_type, rule?.pattern, rule?.category_id]).toEqual(['exact', 'BLUE BOTTLE COFFEE', cat])
    expect(rule?.essentiality).toBe('discretionary')
    const cached = db
      .select()
      .from(merchantClassifications)
      .where(eq(merchantClassifications.merchant_key, 'BLUE BOTTLE COFFEE'))
      .get()
    expect(cached).toBeDefined()
    expect([cached?.source, cached?.category_id]).toEqual(['manual', cat])

    expect(categorizationOf(db, target)?.source).toBe('manual')
    for (const tx of [llmPeer, freshPeer]) {
      const c = categorizationOf(db, tx)
      expect(c).toBeDefined()
      expect([c?.category_id, c?.source, c?.confidence]).toEqual([cat, 'rule', 'very_high'])
    }
    expect(categorizationOf(db, manualPeer)?.category_id).toBe(categoryId(db, 'OTHER_OTHER'))
    expect(categorizationOf(db, other)?.category_id).toBe(categoryId(db, 'OTHER_OTHER'))
  })

  it('save_as_rule updates an existing rule and supports prefix', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-4.00', 'UBER TRIP', '2026-01-10', { merchant_key: 'UBER TRIP' })
    const peer = makeTx(db, acct, '-4.00', 'UBER EATS', '2026-01-10', { merchant_key: 'UBER EATS' })
    categorize(db, tx, 'OTHER_OTHER', 'low')
    categorize(db, peer, 'OTHER_OTHER', 'low')

    const save = (matchType: string, detailed: string) =>
      patched(app, tx.id, { category_id: categoryId(db, detailed), save_as_rule: true, rule_match_type: matchType })

    await save('exact', 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES')
    await save('exact', 'TRANSPORTATION_PUBLIC_TRANSIT')
    const all = db.select().from(rules).all()
    expect(all).toHaveLength(1)
    expect(all[0]?.category_id).toBe(categoryId(db, 'TRANSPORTATION_PUBLIC_TRANSIT'))

    // "UBER" prefix would match both; here the prefix pattern is the full key "UBER TRIP".
    await save('prefix', 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES')
    expect(db.select().from(rules).all()).toHaveLength(2)
    expect(categorizationOf(db, peer)?.category_id).toBe(categoryId(db, 'OTHER_OTHER'))
  })

  it('only an exact rule writes a cache entry (backlog 16)', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-4.00', 'UBER TRIP 1234', '2026-01-10', { merchant_key: 'UBER TRIP' })
    const cat = categoryId(db, 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES')
    await patched(app, tx.id, { category_id: cat, save_as_rule: true, rule_match_type: 'prefix', rule_pattern: 'uber' })
    await patched(app, tx.id, { category_id: cat, save_as_rule: true, rule_match_type: 'contains' })
    expect(db.select().from(merchantClassifications).all()).toEqual([])
    await patched(app, tx.id, { category_id: cat, save_as_rule: true, rule_match_type: 'exact' })
    expect(db.select().from(merchantClassifications).all().map((c) => c.merchant_key)).toEqual(['UBER TRIP'])
  })

  it('rule_pattern sets the pattern; exact and prefix are upper-cased (backlog 17)', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const tx = makeTx(db, acct, '-4.00', 'UBER TRIP', '2026-01-10', { merchant_key: 'UBER TRIP' })
    const peer = makeTx(db, acct, '-4.00', 'UBER EATS', '2026-01-10', { merchant_key: 'UBER EATS' })
    categorize(db, peer, 'OTHER_OTHER', 'low')
    const cat = categoryId(db, 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES')
    await patched(app, tx.id, { category_id: cat, save_as_rule: true, rule_match_type: 'prefix', rule_pattern: '  uber  ' })
    await patched(app, tx.id, { category_id: cat, save_as_rule: true, rule_match_type: 'exact', rule_pattern: 'uber   trip' })
    await patched(app, tx.id, { category_id: cat, save_as_rule: true, rule_match_type: 'contains', rule_pattern: ' Trip ' })
    expect(db.select().from(rules).all().map((r) => [r.match_type, r.pattern])).toEqual([
      ['prefix', 'UBER'],
      ['exact', 'UBER TRIP'],
      ['contains', 'Trip'],
    ])
    expect(categorizationOf(db, peer)?.category_id).toBe(cat) // the "UBER" prefix reached it
    expect((await patch(app, tx.id, { category_id: cat, save_as_rule: true, rule_pattern: '   ' })).status).toBe(400)
  })

  it('a contains rule defaults to the payee when the description contains it, else the description (backlog 17)', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const cat = categoryId(db, 'FOOD_AND_DRINK_COFFEE')
    const withPayee = makeTx(db, acct, '-4.00', 'SQ *BLUE BOTTLE COFFEE 1234', '2026-01-10', { payee: 'Blue Bottle' })
    const folded = makeTx(db, acct, '-4.00', 'MARKT STRASSE 12', '2026-01-10', { payee: 'Markt Straße' })
    const elsewhere = makeTx(db, acct, '-4.00', 'PAYPAL *RITUAL ROASTERS 5555', '2026-01-10', { payee: 'Ritual Coffee' })
    const without = makeTx(db, acct, '-4.00', 'SQ *SIGHTGLASS 9876', '2026-01-10')
    for (const tx of [withPayee, folded, elsewhere, without]) {
      await patched(app, tx.id, { category_id: cat, save_as_rule: true, rule_match_type: 'contains' })
    }
    expect(db.select().from(rules).all().map((r) => r.pattern)).toEqual([
      'Blue Bottle',
      'Markt Straße', // contained under case folding
      'PAYPAL *RITUAL ROASTERS 5555', // the payee is not in the description
      'SQ *SIGHTGLASS 9876',
    ])
  })

  it('save_as_rule computes a missing merchant key', async () => {
    const { app, db } = makeApp()
    const tx = makeTx(db, makeAccount(db), '-4.00', 'SQ *BLUE BOTTLE COFFEE 1234')
    const body = await patched(app, tx.id, { category_id: categoryId(db, 'FOOD_AND_DRINK_COFFEE'), save_as_rule: true })
    expect(body.merchant_key).toBe('BLUE BOTTLE COFFEE')
    const all = db.select().from(rules).all()
    expect(all).toHaveLength(1)
    expect(all[0]?.pattern).toBe('BLUE BOTTLE COFFEE')
  })

  it('sets, strips, and clears a note', async () => {
    const { app, db } = makeApp()
    const tx = makeTx(db, makeAccount(db), '-4.00', 'CLINIC')
    categorize(db, tx, 'OTHER_OTHER', 'low')
    const body = await patched(app, tx.id, { note: '  Therapy, September  ' })
    expect(body.note).toBe('Therapy, September')
    // A note-only change leaves categorization source and confidence alone.
    expect((body.categorization as Body).source).toBe('llm')
    expect((body.categorization as Body).confidence).toBe('low')
    expect((await patched(app, tx.id, { note: '   ' })).note).toBeNull()
    await patched(app, tx.id, { note: 'again' })
    expect((await patched(app, tx.id, { note: null })).note).toBeNull()
    await patched(app, tx.id, { note: 'keep' })
    const r = await patched(app, tx.id, { category_id: categoryId(db, 'OTHER_OTHER') })
    expect(r.note).toBe('keep') // note absent from the request is untouched
  })

  it('a note-only patch works on an uncategorized transaction', async () => {
    const { app, db } = makeApp()
    const tx = makeTx(db, makeAccount(db), '-4.00', 'MYSTERY')
    const body = await patched(app, tx.id, { note: 'cash for Sam' })
    expect(body.note).toBe('cash for Sam')
    expect(body.categorization).toBeNull()
    // Changing the category still requires one.
    expect((await patch(app, tx.id, { essentiality: 'flexible' })).status).toBe(400)
  })

  it('toggles one_time and leaves the categorization alone', async () => {
    const { app, db } = makeApp()
    const tx = makeTx(db, makeAccount(db), '-900.00', 'PARKING FINE')
    categorize(db, tx, 'OTHER_OTHER', 'low')
    const on = await patched(app, tx.id, { one_time: true })
    expect(on.one_time).toBe(true)
    expect((on.categorization as Body).source).toBe('llm')
    const off = await patched(app, tx.id, { one_time: false })
    expect(off.one_time).toBe(false)
    // Absent from a category edit, the flag is untouched.
    await patched(app, tx.id, { one_time: true })
    const r = await patched(app, tx.id, { category_id: categoryId(db, 'OTHER_OTHER') })
    expect(r.one_time).toBe(true)
  })
})

describe('sent fields and search lowering', () => {
  it('rule options without save_as_rule do not count as a category change (backlog 20)', async () => {
    const { app, db } = makeApp()
    const tx = makeTx(db, makeAccount(db), '-4.00', 'MYSTERY')
    const body = await patched(app, tx.id, { note: 'x', save_as_rule: false })
    expect(body.note).toBe('x')
    expect(body.categorization).toBeNull()
    expect((await patched(app, tx.id, { rule_match_type: 'exact', rule_pattern: 'MYST' })).categorization).toBeNull()
    expect(db.select().from(rules).all()).toEqual([])
    expect((await patch(app, tx.id, { category_id: null })).status).toBe(400)
    // A failed patch writes nothing, the note included.
    expect((await patch(app, tx.id, { note: 'z', category_id: null })).status).toBe(400)
    const row = (await list(app)).items[0] as Body
    expect(row.note).toBe('x')
    expect((await patched(app, tx.id, { note: 'y', one_time: true })).note).toBe('y')
  })

  it('a categorized transaction sent only save_as_rule false keeps its categorization', async () => {
    const { app, db } = makeApp()
    const tx = makeTx(db, makeAccount(db), '-4.00', 'MYSTERY')
    categorize(db, tx, 'OTHER_OTHER', 'low')
    const c = (await patched(app, tx.id, { save_as_rule: false })).categorization as Body
    expect([c.source, c.confidence]).toEqual(['llm', 'low'])
  })

  it('q lowers non-ASCII text with the simple lowercase mapping', async () => {
    const { app, db } = makeApp()
    const acct = makeAccount(db)
    const cafe = makeTx(db, acct, '-4.00', 'CAF\u00c9 NOIR')
    const street = makeTx(db, acct, '-4.00', 'MARKT', '2026-01-10', { note: 'Stra\u00dfe' })
    expect(ids(await list(app, { q: 'caf\u00e9' }))).toEqual([cafe.id])
    expect(ids(await list(app, { q: 'STRA\u00dfE' }))).toEqual([street.id])
    expect(ids(await list(app, { q: 'strasse' }))).toEqual([]) // lower() does not fold sharp s
    expect(ids(await list(app, { q: '_' }))).toEqual([]) // LIKE's wildcard is literal
  })
})
