/**
 * SimpleFIN connection, LLM status, and the runtime config.
 */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { claimSetupToken } from '../providers/bank/simplefin.js'
import { ConfigRead, ConfigUpdate } from '../schemas/settings.js'
import { LLMStatus, SimpleFINConnect, SimpleFINStatus } from '../schemas/sync.js'
import * as appSettings from '../services/app_settings.js'
import * as config from '../services/config.js'
import { json, jsonBody, noContent } from './openapi.js'

/** The SimpleFIN claim the connect route uses, looked up per request so tests can swap it. */
export const simplefinClaim: { claim: appSettings.ClaimSetupToken } = {
  claim: (setupToken) => claimSetupToken(setupToken),
}

function read(c: config.RuntimeConfig): ConfigRead {
  return {
    llm_provider: c.llmProvider,
    llm_model: c.llmModel,
    anthropic_api_key_set: c.anthropicApiKeySet,
    ollama_base_url: c.ollamaBaseUrl,
    owner_name_tokens: c.ownerNameTokens,
    sync_interval_hours: c.syncIntervalHours,
    sync_first_history_days: c.syncFirstHistoryDays,
    scheduler_enabled: c.schedulerEnabled,
  }
}

const getSimplefinStatus = createRoute({
  method: 'get',
  path: '/api/settings/simplefin',
  operationId: 'get_simplefin_status',
  summary: 'Get Simplefin Status',
  tags: ['settings'],
  responses: { 200: json(SimpleFINStatus) },
})

const connectSimplefin = createRoute({
  method: 'post',
  path: '/api/settings/simplefin',
  operationId: 'connect_simplefin',
  summary: 'Connect Simplefin',
  description: 'Exchange a SimpleFIN setup token for an access URL and store it encrypted.',
  tags: ['settings'],
  request: { body: jsonBody(SimpleFINConnect) },
  responses: { 200: json(SimpleFINStatus) },
})

const disconnectSimplefin = createRoute({
  method: 'delete',
  path: '/api/settings/simplefin',
  operationId: 'disconnect_simplefin',
  summary: 'Disconnect Simplefin',
  tags: ['settings'],
  responses: { 204: noContent },
})

const getLlmStatus = createRoute({
  method: 'get',
  path: '/api/settings/llm',
  operationId: 'get_llm_status',
  summary: 'Get Llm Status',
  tags: ['settings'],
  responses: { 200: json(LLMStatus) },
})

const getConfig = createRoute({
  method: 'get',
  path: '/api/settings/config',
  operationId: 'get_config',
  summary: 'Get Config',
  tags: ['settings'],
  responses: { 200: json(ConfigRead) },
})

const updateConfig = createRoute({
  method: 'put',
  path: '/api/settings/config',
  operationId: 'update_config',
  summary: 'Update Config',
  tags: ['settings'],
  request: { body: jsonBody(ConfigUpdate) },
  responses: { 200: json(ConfigRead) },
})

export function registerSettings(app: App): void {
  app.openapi(getSimplefinStatus, (c) => {
    return c.json(appSettings.simplefinStatus(c.var.db, c.var.secrets), 200)
  })
  app.openapi(connectSimplefin, async (c) => {
    const { setup_token } = c.req.valid('json')
    const claim = (token: string) => simplefinClaim.claim(token)
    return c.json(await appSettings.connectSimplefin(c.var.db, c.var.secrets, setup_token, claim), 200)
  })
  app.openapi(disconnectSimplefin, (c) => {
    appSettings.disconnectSimplefin(c.var.db)
    return c.body(null, 204)
  })
  app.openapi(getLlmStatus, (c) => {
    return c.json(config.llmStatus(c.var.db, c.var.secrets, c.var.config.defaults), 200)
  })
  app.openapi(getConfig, (c) => {
    return c.json(read(config.runtimeConfig(c.var.db, c.var.secrets, c.var.config.defaults)), 200)
  })
  app.openapi(updateConfig, (c) => {
    const changes = c.req.valid('json')
    const updated = config.updateConfig(c.var.db, c.var.secrets, c.var.config.defaults, changes)
    // The running scheduler follows the stored interval and on/off switch (backlog 31).
    c.var.scheduler?.reschedule()
    return c.json(read(updated), 200)
  })
}
