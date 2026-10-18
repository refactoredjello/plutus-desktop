/** Request and response schemas for sync runs. */

import { z } from '@hono/zod-openapi'
import { DateTime } from './common.js'
import { SyncStatus, SyncTrigger } from './enums.js'
import { model, orNull, requestModel } from './model.js'

export const SyncRunRead = model('SyncRunRead', {
  id: z.int(),
  provider: z.string(),
  trigger: SyncTrigger,
  status: SyncStatus,
  started_at: DateTime,
  finished_at: orNull(DateTime),
  added: z.int(),
  updated: z.int(),
  error_text: z.string().nullable(),
  requests: z.int(),
})
export type SyncRunRead = z.infer<typeof SyncRunRead>

export const SyncSchedule = model('SyncSchedule', {
  enabled: z.boolean(),
  interval_hours: z.int(),
  next_run_at: orNull(DateTime),
})
export type SyncSchedule = z.infer<typeof SyncSchedule>

export const SimpleFINConnect = requestModel('SimpleFINConnect', {
  setup_token: z.string().min(1),
})
export type SimpleFINConnect = z.infer<typeof SimpleFINConnect>

export const SimpleFINStatus = model('SimpleFINStatus', {
  connected: z.boolean(),
  connected_at: orNull(DateTime),
})
export type SimpleFINStatus = z.infer<typeof SimpleFINStatus>

export const LLMStatus = model('LLMStatus', {
  provider: z.string(),
  model: z.string(),
  configured: z.boolean(),
})
export type LLMStatus = z.infer<typeof LLMStatus>
