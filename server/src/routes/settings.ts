/**
 * SimpleFIN connection, LLM status, and the runtime config (new, plan 5.7).
 * Ports app/routers/settings.py (stub).
 */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { ConfigRead, ConfigUpdate } from '../schemas/settings.js'
import { LLMStatus, SimpleFINConnect, SimpleFINStatus } from '../schemas/sync.js'
import { json, jsonBody, noContent, notImplemented } from './openapi.js'

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
  app.openapi(getSimplefinStatus, notImplemented)
  app.openapi(connectSimplefin, notImplemented)
  app.openapi(disconnectSimplefin, notImplemented)
  app.openapi(getLlmStatus, notImplemented)
  app.openapi(getConfig, notImplemented)
  app.openapi(updateConfig, notImplemented)
}
