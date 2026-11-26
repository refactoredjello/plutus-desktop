/** Manual entries. */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { formatMoney } from '../lib/money.js'
import { ManualEntryCreate, ManualEntryRead, ManualEntryUpdate } from '../schemas/manual_entries.js'
import { params, responseList } from '../schemas/model.js'
import { pathInt } from '../schemas/params.js'
import * as service from '../services/manual_entries.js'
import { json, jsonBody, noContent } from './openapi.js'

function read(entry: service.ManualEntry): ManualEntryRead {
  return {
    id: entry.id,
    amount: formatMoney(entry.amount),
    description: entry.description,
    category_id: entry.category_id,
    due_date: entry.due_date,
    recurrence: entry.recurrence,
    end_date: entry.end_date,
    fulfilled_transaction_id: entry.fulfilled_transaction_id,
  }
}

const listManualEntries = createRoute({
  method: 'get',
  path: '/api/manual-entries',
  operationId: 'list_manual_entries',
  summary: 'List Manual Entries',
  tags: ['manual-entries'],
  responses: { 200: json(responseList(ManualEntryRead, 'list_manual_entries')) },
})

const createManualEntry = createRoute({
  method: 'post',
  path: '/api/manual-entries',
  operationId: 'create_manual_entry',
  summary: 'Create Manual Entry',
  tags: ['manual-entries'],
  request: { body: jsonBody(ManualEntryCreate) },
  responses: { 201: json(ManualEntryRead) },
})

const updateManualEntry = createRoute({
  method: 'patch',
  path: '/api/manual-entries/{entry_id}',
  operationId: 'update_manual_entry',
  summary: 'Update Manual Entry',
  tags: ['manual-entries'],
  request: { params: params({ entry_id: pathInt() }), body: jsonBody(ManualEntryUpdate) },
  responses: { 200: json(ManualEntryRead) },
})

const deleteManualEntry = createRoute({
  method: 'delete',
  path: '/api/manual-entries/{entry_id}',
  operationId: 'delete_manual_entry',
  summary: 'Delete Manual Entry',
  tags: ['manual-entries'],
  request: { params: params({ entry_id: pathInt() }) },
  responses: { 204: noContent },
})

export function registerManualEntries(app: App): void {
  app.openapi(listManualEntries, (c) => c.json(service.listManualEntries(c.var.db).map(read), 200))
  app.openapi(createManualEntry, (c) => c.json(read(service.createManualEntry(c.var.db, c.req.valid('json'))), 201))
  app.openapi(updateManualEntry, (c) => {
    const { entry_id } = c.req.valid('param')
    return c.json(read(service.updateManualEntry(c.var.db, entry_id, c.req.valid('json'))), 200)
  })
  app.openapi(deleteManualEntry, (c) => {
    const { entry_id } = c.req.valid('param')
    service.deleteManualEntry(c.var.db, entry_id)
    return c.body(null, 204)
  })
}
