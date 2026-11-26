/**
 * The runtime config contract. The Anthropic API key is write-only: reads say only whether it
 * is set.
 */

import { z } from '@hono/zod-openapi'
import { LLM_PROVIDERS } from '../config.js'
import { model, requestModel } from './model.js'

export const ConfigRead = model('ConfigRead', {
  llm_provider: z.enum(LLM_PROVIDERS),
  llm_model: z.string(),
  anthropic_api_key_set: z.boolean(),
  ollama_base_url: z.string(),
  owner_name_tokens: z.array(z.string()),
  sync_interval_hours: z.int(),
  sync_first_history_days: z.int(),
  scheduler_enabled: z.boolean(),
})
export type ConfigRead = z.infer<typeof ConfigRead>

/** Every field optional; `anthropic_api_key: null` clears the key. */
export const ConfigUpdate = requestModel('ConfigUpdate', {
  llm_provider: z.enum(LLM_PROVIDERS).optional(),
  llm_model: z.string().min(1).optional(),
  anthropic_api_key: z.string().nullable().optional(),
  ollama_base_url: z.string().optional(),
  owner_name_tokens: z.array(z.string()).optional(),
  sync_interval_hours: z.int().min(1).optional(),
  sync_first_history_days: z.int().min(1).optional(),
  scheduler_enabled: z.boolean().optional(),
})
export type ConfigUpdate = z.infer<typeof ConfigUpdate>

/** The window's colour theme: follow the system, or always light or dark. */
export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

export const AppearanceRead = model('AppearanceRead', { theme: z.enum(THEMES) })
export type AppearanceRead = z.infer<typeof AppearanceRead>

export const AppearanceUpdate = requestModel('AppearanceUpdate', { theme: z.enum(THEMES) })
export type AppearanceUpdate = z.infer<typeof AppearanceUpdate>
