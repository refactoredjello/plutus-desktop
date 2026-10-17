import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'
import { DateTime, Money, Page, PlainDate } from '../src/schemas/common.js'
import { HealthRead } from '../src/schemas/health.js'

describe('Money', () => {
  it.each(['123.45', '-15.49', '0.00', '1000000.00'])('accepts %j', (value) => {
    expect(Money.safeParse(value).success).toBe(true)
  })

  it.each(['12', '12.5', '12.345', '+1.00', '1,000.00', '', '-.50'])('rejects %j', (value) => {
    expect(Money.safeParse(value).success).toBe(false)
  })

  it('rejects numbers: money is never a float on the wire', () => {
    expect(Money.safeParse(12.5).success).toBe(false)
  })
})

describe('PlainDate and DateTime', () => {
  it('accepts real dates only', () => {
    expect(PlainDate.safeParse('2026-02-28').success).toBe(true)
    expect(PlainDate.safeParse('2026-02-30').success).toBe(false)
    expect(PlainDate.safeParse('2026-2-3').success).toBe(false)
  })

  it('accepts ISO timestamps', () => {
    expect(DateTime.safeParse('2026-10-03T15:47:00.217Z').success).toBe(true)
    expect(DateTime.safeParse('2026-10-03T15:47:00.217118+00:00').success).toBe(true)
    expect(DateTime.safeParse('2026-10-03').success).toBe(false)
  })
})

describe('OpenAPI components', () => {
  const Item = z.object({ id: z.number().int(), amount: Money, posted_on: PlainDate }).openapi('TransactionRead')
  const app = new OpenAPIHono()
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/items',
      responses: { 200: { content: { 'application/json': { schema: Page(Item, 'TransactionRead') } }, description: 'ok' } },
    }),
    (c) => c.json({ items: [], total: 0, limit: 50, offset: 0 }, 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/health',
      responses: { 200: { content: { 'application/json': { schema: HealthRead } }, description: 'ok' } },
    }),
    (c) => c.json({ status: 'ok' as const, database: 'ok' as const, version: '0.1.0' }, 200),
  )
  const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'Plutus API', version: '0.1.0' } })
  const schemas = doc.components?.schemas ?? {}

  it('names Page<T> like FastAPI: Page_<Name>_', () => {
    expect(Object.keys(schemas)).toContain('Page_TransactionRead_')
    expect(schemas.Page_TransactionRead_).toMatchObject({
      type: 'object',
      required: ['items', 'total', 'limit', 'offset'],
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/TransactionRead' } },
        total: { type: 'integer' },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
      },
    })
  })

  it('describes money as a string and dates with format date', () => {
    expect(schemas.TransactionRead).toMatchObject({
      properties: {
        amount: { type: 'string' },
        posted_on: { type: 'string', format: 'date' },
      },
    })
  })

  it('registers HealthRead with the Pydantic shape', () => {
    expect(schemas.HealthRead).toMatchObject({
      type: 'object',
      required: ['status', 'database', 'version'],
      properties: {
        status: { type: 'string', enum: ['ok', 'degraded'] },
        database: { type: 'string', enum: ['ok', 'unreachable'] },
        version: { type: 'string' },
      },
    })
  })
})
