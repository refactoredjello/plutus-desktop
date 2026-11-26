/** Routes for transactions. */

import { createRoute, z } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { PlainDate } from '../schemas/common.js'
import { EssentialityFilter } from '../schemas/enums.js'
import { orNull, params } from '../schemas/model.js'
import { pathInt, queryBool, queryInt, queryIntList } from '../schemas/params.js'
import { TransactionPage, TransactionRead, TransactionRuleRead, TransactionUpdate } from '../schemas/transactions.js'
import { plainDate } from '../lib/dates.js'
import * as service from '../services/transactions.js'
import { unpairTransfer } from '../services/transfers.js'
import { json, jsonBody, noContent } from './openapi.js'

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

const transactionRule = createRoute({
  method: 'get',
  path: '/api/transactions/{transaction_id}/rule',
  operationId: 'get_transaction_rule',
  summary: 'Get Transaction Rule',
  description:
    'The rule that categorizes this transaction, with categorization\'s precedence (exact, contains, prefix), ' +
    'or null; and defaults for a new rule.',
  tags: ['transactions'],
  request: { params: params({ transaction_id: pathInt() }) },
  responses: { 200: json(TransactionRuleRead) },
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

const markPosted = createRoute({
  method: 'post',
  path: '/api/transactions/{transaction_id}/mark-posted',
  operationId: 'mark_transaction_posted',
  summary: 'Mark Pending Transaction Posted',
  description:
    'A pending transaction the bank will not return again becomes posted, so it counts in totals. ' +
    'A later sync sets it back to pending only if the bank returns it as pending. 409 for a posted transaction.',
  tags: ['transactions'],
  request: { params: params({ transaction_id: pathInt() }) },
  responses: { 200: json(TransactionRead) },
})

const removePending = createRoute({
  method: 'delete',
  path: '/api/transactions/{transaction_id}',
  operationId: 'delete_pending_transaction',
  summary: 'Remove Pending Transaction',
  description: 'Delete a pending transaction that never became a charge. 409 for a posted transaction.',
  tags: ['transactions'],
  request: { params: params({ transaction_id: pathInt() }) },
  responses: { 204: noContent },
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
  app.openapi(transactionRule, (c) => {
    const { db, secrets, config } = c.var
    return c.json(service.transactionRule(db, secrets, config.defaults, c.req.valid('param').transaction_id), 200)
  })
  app.openapi(unpairTransaction, (c) => c.json(unpairTransfer(c.var.db, c.req.valid('param').transaction_id), 200))
  app.openapi(markPosted, (c) => c.json(service.markPosted(c.var.db, c.req.valid('param').transaction_id), 200))
  app.openapi(removePending, (c) => {
    service.removePending(c.var.db, c.req.valid('param').transaction_id)
    return c.body(null, 204)
  })
}
