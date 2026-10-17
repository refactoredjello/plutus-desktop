/** Ports app/routers/transactions.py (stub). */

import { createRoute, z } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { PlainDate } from '../schemas/common.js'
import { EssentialityFilter } from '../schemas/enums.js'
import { nullableRef, params } from '../schemas/model.js'
import { pathInt, queryBool, queryInt, queryIntList } from '../schemas/params.js'
import { TransactionPage, TransactionRead, TransactionUpdate } from '../schemas/transactions.js'
import { json, jsonBody, notImplemented } from './openapi.js'

const listTransactions = createRoute({
  method: 'get',
  path: '/api/transactions',
  operationId: 'list_transactions',
  summary: 'List Transactions',
  tags: ['transactions'],
  request: {
    query: params({
      q: z.string().nullable().optional(),
      start: PlainDate.nullable().optional(),
      end: PlainDate.nullable().optional(),
      account_id: queryIntList(),
      category_id: queryIntList(),
      essentiality: nullableRef(EssentialityFilter).optional(),
      uncategorized: queryBool(false),
      needs_review: queryBool(false),
      include_transfers: queryBool(false),
      limit: queryInt(50, { minimum: 1, maximum: 500 }),
      offset: queryInt(0, { minimum: 0 }),
    }),
  },
  responses: { 200: json(TransactionPage) },
})

const updateTransaction = createRoute({
  method: 'patch',
  path: '/api/transactions/{transaction_id}',
  operationId: 'update_transaction',
  summary: 'Update Transaction',
  tags: ['transactions'],
  request: { params: params({ transaction_id: pathInt() }), body: jsonBody(TransactionUpdate) },
  responses: { 200: json(TransactionRead) },
})

export function registerTransactions(app: App): void {
  app.openapi(listTransactions, notImplemented)
  app.openapi(updateTransaction, notImplemented)
}
