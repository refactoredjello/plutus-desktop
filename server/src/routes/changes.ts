/**
 * What changed (R12): signals about the current month, and their dismissals.
 */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { today } from '../lib/dates.js'
import { ChangesRead, DismissChange } from '../schemas/changes.js'
import { params } from '../schemas/model.js'
import { queryBool } from '../schemas/params.js'
import * as service from '../services/changes.js'
import { json, jsonBody, noContent } from './openapi.js'

const getChanges = createRoute({
  method: 'get',
  path: '/api/reports/changes',
  operationId: 'get_changes',
  summary: 'Get Changes',
  description: 'Up to seven items; `all=true` returns every item so the card can expand in place.',
  tags: ['changes'],
  request: { query: params({ all: queryBool(false) }) },
  responses: { 200: json(ChangesRead) },
})

const dismissChange = createRoute({
  method: 'post',
  path: '/api/reports/changes/dismiss',
  operationId: 'dismiss_change',
  summary: 'Dismiss Change',
  tags: ['changes'],
  request: { body: jsonBody(DismissChange) },
  responses: { 204: noContent },
})

const clearChangeDismissals = createRoute({
  method: 'delete',
  path: '/api/reports/changes/dismissals',
  operationId: 'clear_change_dismissals',
  summary: 'Clear Change Dismissals',
  tags: ['changes'],
  responses: { 204: noContent },
})

export function registerChanges(app: App): void {
  app.openapi(getChanges, (c) => {
    const { all } = c.req.valid('query')
    return c.json(service.compute(c.var.db, today(), { includeAll: all }), 200)
  })
  app.openapi(dismissChange, (c) => {
    service.dismiss(c.var.db, c.req.valid('json').key)
    return c.body(null, 204)
  })
  app.openapi(clearChangeDismissals, (c) => {
    service.clearDismissals(c.var.db)
    return c.body(null, 204)
  })
}
