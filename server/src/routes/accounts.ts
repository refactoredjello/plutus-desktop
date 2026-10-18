/** Accounts with their latest balance snapshot. */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { AccountRead } from '../schemas/accounts.js'
import { responseList } from '../schemas/model.js'
import * as service from '../services/accounts.js'
import { json } from './openapi.js'

const listAccounts = createRoute({
  method: 'get',
  path: '/api/accounts',
  operationId: 'list_accounts',
  summary: 'List Accounts',
  tags: ['accounts'],
  responses: { 200: json(responseList(AccountRead, 'list_accounts')) },
})

export function registerAccounts(app: App): void {
  app.openapi(listAccounts, (c) => c.json(service.listAccounts(c.var.db), 200))
}
