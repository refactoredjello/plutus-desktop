/** Ports app/routers/recurring.py (stub). */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { RecurrenceStatus } from '../schemas/enums.js'
import { orNull, params, responseList } from '../schemas/model.js'
import { pathInt } from '../schemas/params.js'
import { RecurringChargeCreate, RecurringChargeRead, RecurringChargeUpdate } from '../schemas/recurring.js'
import { json, jsonBody, notImplemented } from './openapi.js'

const listRecurring = createRoute({
  method: 'get',
  path: '/api/recurring',
  operationId: 'list_recurring',
  summary: 'List Recurring',
  tags: ['recurring'],
  request: { query: params({ status: orNull(RecurrenceStatus).optional() }) },
  responses: { 200: json(responseList(RecurringChargeRead, 'list_recurring')) },
})

const markRecurring = createRoute({
  method: 'post',
  path: '/api/recurring',
  operationId: 'mark_recurring',
  summary: 'Mark Recurring',
  description: "Mark a transaction's merchant as a confirmed recurring charge.",
  tags: ['recurring'],
  request: { body: jsonBody(RecurringChargeCreate) },
  responses: { 201: json(RecurringChargeRead) },
})

const updateRecurring = createRoute({
  method: 'patch',
  path: '/api/recurring/{recurring_id}',
  operationId: 'update_recurring',
  summary: 'Update Recurring',
  tags: ['recurring'],
  request: { params: params({ recurring_id: pathInt() }), body: jsonBody(RecurringChargeUpdate) },
  responses: { 200: json(RecurringChargeRead) },
})

export function registerRecurring(app: App): void {
  app.openapi(listRecurring, notImplemented)
  app.openapi(markRecurring, notImplemented)
  app.openapi(updateRecurring, notImplemented)
}
