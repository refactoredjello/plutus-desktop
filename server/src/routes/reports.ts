/** Ports app/routers/reports.py (stub). */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { PlainDate } from '../schemas/common.js'
import { EssentialityFilter } from '../schemas/enums.js'
import { orNull, params, responseList } from '../schemas/model.js'
import { MonthDetail } from '../schemas/month.js'
import { Month, queryInt } from '../schemas/params.js'
import { AccountBalanceSeries, CategoryTotal, MonthlySummary } from '../schemas/reports.js'
import { json, notImplemented } from './openapi.js'

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
  app.openapi(getMonthlySummary, notImplemented)
  app.openapi(getMonthDetail, notImplemented)
  app.openapi(getSpendingByCategory, notImplemented)
  app.openapi(getBalanceHistory, notImplemented)
}
