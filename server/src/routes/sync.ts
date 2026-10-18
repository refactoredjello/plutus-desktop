/**
 * Manual sync trigger and run history. Ports app/routers/sync.py.
 *
 * POST /api/sync answers 202 and starts the run without awaiting it, like FastAPI's
 * BackgroundTasks (plan 5.8). The detached run records its own failure and never rejects;
 * `backgroundSyncsSettled()` lets tests and shutdown wait for it.
 */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import type { Logger } from '../lib/log.js'
import { params, responseList } from '../schemas/model.js'
import { pathInt, queryInt } from '../schemas/params.js'
import { SyncRunRead, SyncSchedule } from '../schemas/sync.js'
import { runtimeConfig } from '../services/config.js'
import * as sync from '../services/sync.js'
import { json } from './openapi.js'

const background = new Set<Promise<void>>()

/** Resolves when every detached sync started so far has finished. */
export async function backgroundSyncsSettled(): Promise<void> {
  while (background.size > 0) await Promise.all([...background])
}

function detach(task: () => Promise<void>, log: Logger): void {
  const done = Promise.resolve()
    .then(task)
    .catch((err: unknown) => log.error({ err }, 'sync_background_crashed'))
    .finally(() => background.delete(done))
  background.add(done)
}

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
  app.openapi(startSync, (c) => {
    const { db, secrets, config, log } = c.var
    const run = sync.startManualSync(db, secrets, config.defaults, log)
    detach(() => sync.executeInBackground(db, secrets, config.defaults, run.id, log), log)
    return c.json(run, 202)
  })
  app.openapi(getSyncSchedule, (c) => {
    const { syncIntervalHours, schedulerEnabled } = runtimeConfig(c.var.db, c.var.secrets, c.var.config.defaults)
    return c.json(
      { enabled: schedulerEnabled, interval_hours: syncIntervalHours, next_run_at: c.var.scheduler?.nextRunAt() ?? null },
      200,
    )
  })
  app.openapi(listSyncRuns, (c) => {
    const { limit } = c.req.valid('query')
    return c.json(sync.listRuns(c.var.db, limit), 200)
  })
  app.openapi(getSyncRun, (c) => {
    const { run_id } = c.req.valid('param')
    return c.json(sync.getRun(c.var.db, run_id), 200)
  })
}
