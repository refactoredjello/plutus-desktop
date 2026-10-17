/**
 * What changed (R12): signals about the current month, and their dismissals.
 * Ports app/routers/changes.py (stub).
 */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { ChangesRead, DismissChange } from '../schemas/changes.js'
import { params } from '../schemas/model.js'
import { queryBool } from '../schemas/params.js'
import { json, jsonBody, noContent, notImplemented } from './openapi.js'

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
  app.openapi(getChanges, notImplemented)
  app.openapi(dismissChange, notImplemented)
  app.openapi(clearChangeDismissals, notImplemented)
}
