/** Routes for reports. */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { plainDate } from '../lib/dates.js'
import { PlainDate } from '../schemas/common.js'
import { EssentialityFilter } from '../schemas/enums.js'
import { orNull, params, responseList } from '../schemas/model.js'
import { MonthDetail } from '../schemas/month.js'
import { Month, queryInt } from '../schemas/params.js'
import { AccountBalanceSeries, CategoryTotal, MonthlySummary } from '../schemas/reports.js'
import { balanceHistory, monthDetail, monthlySummary, spendingByCategory } from '../services/reports.js'
import { json } from './openapi.js'

const getMonthlySummary = createRoute({
  method: 'get',
  path: '/api/reports/monthly',
  operationId: 'get_monthly_summary',
  summary: 'Get Monthly Summary',
  tags: ['reports'],
  request: { query: params({ months: queryInt(12, { minimum: 1, maximum: 60 }) }) },
  responses: { 200: json(responseList(MonthlySummary, 'get_monthly_summary')) },
})

const getMonthDetail = createRoute({
  method: 'get',
  path: '/api/reports/month/{month}',
  operationId: 'get_month_detail',
  summary: 'Get Month Detail',
  description: 'One month in detail: totals vs recent average, essentiality, categories, largest.',
  tags: ['reports'],
  request: { params: params({ month: Month }) },
  responses: { 200: json(MonthDetail) },
})

const getSpendingByCategory = createRoute({
  method: 'get',
  path: '/api/reports/by-category',
  operationId: 'get_spending_by_category',
  summary: 'Get Spending By Category',
  tags: ['reports'],
  request: {
    query: params({
      month: Month,
      essentiality: orNull(EssentialityFilter).optional(),
    }),
  },
  responses: { 200: json(responseList(CategoryTotal, 'get_spending_by_category')) },
})

const getBalanceHistory = createRoute({
  method: 'get',
  path: '/api/reports/balances',
  operationId: 'get_balance_history',
  summary: 'Get Balance History',
  tags: ['reports'],
  request: {
    query: params({
      start: PlainDate.nullable().optional(),
      end: PlainDate.nullable().optional(),
    }),
  },
  responses: { 200: json(responseList(AccountBalanceSeries, 'get_balance_history')) },
})

export function registerReports(app: App): void {
  app.openapi(getMonthlySummary, (c) => c.json(monthlySummary(c.var.db, c.req.valid('query').months), 200))
  app.openapi(getMonthDetail, (c) => c.json(monthDetail(c.var.db, c.req.valid('param').month), 200))
  app.openapi(getSpendingByCategory, (c) => {
    const { month, essentiality } = c.req.valid('query')
    return c.json(spendingByCategory(c.var.db, month, essentiality ?? null), 200)
  })
  app.openapi(getBalanceHistory, (c) => {
    const { start, end } = c.req.valid('query')
    return c.json(balanceHistory(c.var.db, start ? plainDate(start) : null, end ? plainDate(end) : null), 200)
  })
}
