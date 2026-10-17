/** Manual entries (R5). Ports app/routers/manual_entries.py (stub). */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { ManualEntryCreate, ManualEntryRead, ManualEntryUpdate } from '../schemas/manual_entries.js'
import { params, responseList } from '../schemas/model.js'
import { pathInt } from '../schemas/params.js'
import { json, jsonBody, noContent, notImplemented } from './openapi.js'

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
  app.openapi(listManualEntries, notImplemented)
  app.openapi(createManualEntry, notImplemented)
  app.openapi(updateManualEntry, notImplemented)
  app.openapi(deleteManualEntry, notImplemented)
}
