/** Manual sync trigger and run history. Ports app/routers/sync.py (stub). */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { params, responseList } from '../schemas/model.js'
import { pathInt, queryInt } from '../schemas/params.js'
import { SyncRunRead, SyncSchedule } from '../schemas/sync.js'
import { json, notImplemented } from './openapi.js'

const startSync = createRoute({
  method: 'post',
  path: '/api/sync',
  operationId: 'start_sync',
  summary: 'Start Sync',
  description: 'Start a manual sync in the background. Poll the returned run for status.',
  tags: ['sync'],
  responses: { 202: json(SyncRunRead) },
})

const getSyncSchedule = createRoute({
  method: 'get',
  path: '/api/sync/schedule',
  operationId: 'get_sync_schedule',
  summary: 'Get Sync Schedule',
  description: 'When the next scheduled sync will run (before a few minutes of jitter).',
  tags: ['sync'],
  responses: { 200: json(SyncSchedule) },
})

const listSyncRuns = createRoute({
  method: 'get',
  path: '/api/sync/runs',
  operationId: 'list_sync_runs',
  summary: 'List Sync Runs',
  tags: ['sync'],
  request: { query: params({ limit: queryInt(20, { minimum: 1, maximum: 100 }) }) },
  responses: { 200: json(responseList(SyncRunRead, 'list_sync_runs')) },
})

const getSyncRun = createRoute({
  method: 'get',
  path: '/api/sync/runs/{run_id}',
  operationId: 'get_sync_run',
  summary: 'Get Sync Run',
  tags: ['sync'],
  request: { params: params({ run_id: pathInt() }) },
  responses: { 200: json(SyncRunRead) },
})

export function registerSync(app: App): void {
  app.openapi(startSync, notImplemented)
  app.openapi(getSyncSchedule, notImplemented)
  app.openapi(listSyncRuns, notImplemented)
  app.openapi(getSyncRun, notImplemented)
}
