/** POST /api/recalculate: the header's Refresh button. Local only; see services/recalculate.ts. */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { RecalculateRead } from '../schemas/recalculate.js'
import { recalculate } from '../services/recalculate.js'
import { json } from './openapi.js'

const recalculateRoute = createRoute({
  method: 'post',
  path: '/api/recalculate',
  operationId: 'recalculate',
  summary: 'Recalculate',
  description:
    'Re-apply rules to non-manual categorizations, categorize from the merchant cache, and detect recurring charges. No bank request and no LLM.',
  tags: ['recalculate'],
  responses: { 200: json(RecalculateRead) },
})

export function registerRecalculate(app: App): void {
  app.openapi(recalculateRoute, (c) => {
    const { db, secrets, config } = c.var
    return c.json(recalculate(db, secrets, config.defaults), 200)
  })
}
