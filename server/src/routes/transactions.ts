/** Routes for transactions. */

import { createRoute, z } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { PlainDate } from '../schemas/common.js'
import { EssentialityFilter } from '../schemas/enums.js'
import { orNull, params } from '../schemas/model.js'
import { pathInt, queryBool, queryInt, queryIntList } from '../schemas/params.js'
import { TransactionPage, TransactionRead, TransactionUpdate } from '../schemas/transactions.js'
import { plainDate } from '../lib/dates.js'
import * as service from '../services/transactions.js'
import { unpairTransfer } from '../services/transfers.js'
import { json, jsonBody } from './openapi.js'

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
      essentiality: orNull(EssentialityFilter).optional(),
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

const unpairTransaction = createRoute({
  method: 'post',
  path: '/api/transactions/{transaction_id}/unpair',
  operationId: 'unpair_transaction',
  summary: 'Unpair Transfer',
  description: 'Split a transfer pair: both rows count as ordinary transactions again, and later syncs leave them unpaired.',
  tags: ['transactions'],
  request: { params: params({ transaction_id: pathInt() }) },
  responses: { 200: json(TransactionRead) },
})

export function registerTransactions(app: App): void {
  app.openapi(listTransactions, (c) => {
    const query = c.req.valid('query')
    const [items, total] = service.listTransactions(c.var.db, {
      q: query.q ?? null,
      start: query.start ? plainDate(query.start) : null,
      end: query.end ? plainDate(query.end) : null,
      account_ids: query.account_id ?? null,
      category_ids: query.category_id ?? null,
      essentiality: query.essentiality ?? null,
      uncategorized: query.uncategorized,
      needs_review: query.needs_review,
      include_transfers: query.include_transfers,
      limit: query.limit,
      offset: query.offset,
    })
    return c.json({ items, total, limit: query.limit, offset: query.offset }, 200)
  })
  app.openapi(updateTransaction, async (c) => {
    // The keys the client sent, so absent fields stay untouched (the body is validated, so known).
    const fields = new Set(Object.keys((await c.req.json()) as object))
    const { db, secrets, config } = c.var
    const tx = service.updateTransaction(db, secrets, config.defaults, c.req.valid('param').transaction_id, c.req.valid('json'), fields)
    return c.json(tx, 200)
  })
  app.openapi(unpairTransaction, (c) => c.json(unpairTransfer(c.var.db, c.req.valid('param').transaction_id), 200))
}
