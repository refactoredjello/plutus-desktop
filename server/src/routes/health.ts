/** Routes for the health check. The version is the app's (AppDeps.appVersion). */

import { createRoute } from '@hono/zod-openapi'
import { sql } from 'drizzle-orm'
import type { App } from '../app.js'
import { HealthRead } from '../schemas/health.js'

const getHealth = createRoute({
  method: 'get',
  path: '/api/health',
  operationId: 'get_health',
  summary: 'Get Health',
  tags: ['health'],
  responses: {
    200: {
      content: { 'application/json': { schema: HealthRead } },
      description: 'Successful Response',
    },
  },
})

export function registerHealth(app: App): void {
  app.openapi(getHealth, (c) => {
    try {
      c.var.db.run(sql`SELECT 1`)
    } catch {
      return c.json({ status: 'degraded' as const, database: 'unreachable' as const, version: c.var.appVersion }, 200)
    }
    return c.json({ status: 'ok' as const, database: 'ok' as const, version: c.var.appVersion }, 200)
  })
}
