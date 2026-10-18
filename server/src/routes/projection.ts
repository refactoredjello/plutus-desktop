/** Routes for the balance projection. */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { formatMoney } from '../lib/money.js'
import { params } from '../schemas/model.js'
import { queryInt } from '../schemas/params.js'
import { ProjectionRead } from '../schemas/projection.js'
import * as service from '../services/projection.js'
import { json } from './openapi.js'

function read(p: service.Projection): ProjectionRead {
  return {
    as_of: p.as_of,
    current_balance: formatMoney(p.current_balance),
    months: p.months.map((m) => ({
      month: m.month,
      starting_balance: formatMoney(m.starting_balance),
      recurring_income: formatMoney(m.recurring_income),
      recurring_expenses: formatMoney(m.recurring_expenses),
      manual_income: formatMoney(m.manual_income),
      manual_expenses: formatMoney(m.manual_expenses),
      variable_spending: formatMoney(m.variable_spending),
      variable_income: formatMoney(m.variable_income),
      projected_end_balance: formatMoney(m.projected_end_balance),
    })),
    assumptions: p.assumptions,
  }
}

const getProjection = createRoute({
  method: 'get',
  path: '/api/projection',
  operationId: 'get_projection',
  summary: 'Get Projection',
  tags: ['projection'],
  request: { query: params({ months: queryInt(3, { minimum: 1, maximum: 12 }) }) },
  responses: { 200: json(ProjectionRead) },
})

export function registerProjection(app: App): void {
  app.openapi(getProjection, (c) => {
    const { months } = c.req.valid('query')
    return c.json(read(service.project(c.var.db, months)), 200)
  })
}
