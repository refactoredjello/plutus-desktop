/**
 * Category and rule routes. The LLM status test lives in settings_routes.test.ts, with the
 * settings routes it exercises.
 */

import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { categories, rules } from '../src/db/schema.js'
import { categoryId } from './factories.js'
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
