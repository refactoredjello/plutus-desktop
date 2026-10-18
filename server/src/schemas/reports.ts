/** Request and response schemas for reports. */

import { z } from '@hono/zod-openapi'
import { Money, PlainDate } from './common.js'
import { model } from './model.js'

export const MonthlySummary = model(
  'MonthlySummary',
  {
    month: z.string(), // YYYY-MM
    income: Money,
    expenses: Money,
    net: Money,
    essential: Money,
    flexible: Money,
    discretionary: Money,
    uncategorized: Money,
  },
  'Totals for one calendar month. Transfers excluded. Expenses are positive numbers.',
)
export type MonthlySummary = z.infer<typeof MonthlySummary>

export const CategoryTotal = model('CategoryTotal', {
  category_id: z.int().nullable(),
  label: z.string(),
  primary: z.string().nullable(),
  total: Money,
  count: z.int(),
})
export type CategoryTotal = z.infer<typeof CategoryTotal>

export const BalancePoint = model('BalancePoint', {
  on: PlainDate,
  balance: Money,
})
export type BalancePoint = z.infer<typeof BalancePoint>

export const AccountBalanceSeries = model('AccountBalanceSeries', {
  account_id: z.int(),
  name: z.string(),
  points: z.array(BalancePoint),
})
export type AccountBalanceSeries = z.infer<typeof AccountBalanceSeries>
