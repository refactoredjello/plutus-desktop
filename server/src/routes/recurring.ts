/** Routes for recurring charges. */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import type { Db } from '../db/index.js'
import { formatMoney } from '../lib/money.js'
import { RecurrenceStatus } from '../schemas/enums.js'
import { orNull, params, responseList } from '../schemas/model.js'
import { pathInt } from '../schemas/params.js'
import { RecurringChargeCreate, RecurringChargeRead, RecurringChargeUpdate } from '../schemas/recurring.js'
import * as service from '../services/recurring.js'
import { json, jsonBody } from './openapi.js'

function read(db: Db, charge: service.RecurringCharge, names: Map<number, string>): RecurringChargeRead {
  const next = service.estimateFor(db, charge, charge.next_expected_date)
  return {
    id: charge.id,
    merchant_key: charge.merchant_key,
    name: names.get(charge.id) ?? charge.merchant_key,
    account_id: charge.account_id,
    amount: formatMoney(charge.amount),
    cadence: charge.cadence,
    next_expected_date: charge.next_expected_date,
    last_seen_on: charge.last_seen_on,
    status: charge.status,
    essentiality: charge.essentiality,
    amount_varies: charge.amount_varies,
    next_amount: formatMoney(next.amount),
    estimate_basis: next.basis,
    annual_cost: formatMoney(service.annualCostFor(db, charge)),
  }
}

function one(db: Db, charge: service.RecurringCharge): RecurringChargeRead {
  return read(db, charge, service.recurringNames(db, [charge]))
}

const listRecurring = createRoute({
  method: 'get',
  path: '/api/recurring',
  operationId: 'list_recurring',
  summary: 'List Recurring',
  tags: ['recurring'],
  request: { query: params({ status: orNull(RecurrenceStatus).optional() }) },
  responses: { 200: json(responseList(RecurringChargeRead, 'list_recurring')) },
})

const markRecurring = createRoute({
  method: 'post',
  path: '/api/recurring',
  operationId: 'mark_recurring',
  summary: 'Mark Recurring',
  description: "Mark a transaction's merchant as a confirmed recurring charge.",
  tags: ['recurring'],
  request: { body: jsonBody(RecurringChargeCreate) },
  responses: { 201: json(RecurringChargeRead) },
})

const updateRecurring = createRoute({
  method: 'patch',
  path: '/api/recurring/{recurring_id}',
  operationId: 'update_recurring',
  summary: 'Update Recurring',
  tags: ['recurring'],
  request: { params: params({ recurring_id: pathInt() }), body: jsonBody(RecurringChargeUpdate) },
  responses: { 200: json(RecurringChargeRead) },
})

export function registerRecurring(app: App): void {
  app.openapi(listRecurring, (c) => {
    const { status } = c.req.valid('query')
    const charges = service.listRecurring(c.var.db, status ?? null)
    const names = service.recurringNames(c.var.db, charges)
    return c.json(charges.map((charge) => read(c.var.db, charge, names)), 200)
  })
  app.openapi(markRecurring, (c) => {
    const body = c.req.valid('json')
    return c.json(one(c.var.db, service.markRecurring(c.var.db, body.transaction_id, body.cadence, body.amount_varies)), 201)
  })
  app.openapi(updateRecurring, (c) => {
    const { recurring_id } = c.req.valid('param')
    return c.json(one(c.var.db, service.updateRecurring(c.var.db, recurring_id, c.req.valid('json'))), 200)
  })
}
