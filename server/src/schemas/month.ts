/** Request and response schemas for the month view. */

import { z } from '@hono/zod-openapi'
import { Money } from './common.js'
import { EssentialityFilter } from './enums.js'
import { model } from './model.js'
import { TransactionRead } from './transactions.js'

export const EssentialityShare = model('EssentialityShare', {
  essentiality: EssentialityFilter,
  total: Money,
  share: z.number(), // of the month's expenses, 0..1 (can exceed 1 or go negative with refunds)
})
export type EssentialityShare = z.infer<typeof EssentialityShare>

export const MonthCategory = model('MonthCategory', {
  category_id: z.int().nullable(), // null = uncategorized spending
  label: z.string(),
  primary: z.string().nullable(),
  total: Money,
  count: z.int(),
  average: Money.nullable(), // over `average_months` prior months; null when there are none
})
export type MonthCategory = z.infer<typeof MonthCategory>

export const MonthDetail = model(
  'MonthDetail',
  {
    month: z.string(), // YYYY-MM
    is_complete: z.boolean(),
    days_elapsed: z.int(),
    days_in_month: z.int(),
    average_months: z.int(), // prior months with data used for averages (0-3)
    income: Money,
    income_average: Money.nullable(),
    expenses: Money,
    expenses_average: Money.nullable(),
    net: Money,
    net_average: Money.nullable(),
    savings_rate: z.number().nullable(), // net / income; null when there is no income
    savings_rate_average: z.number().nullable(),
    essentiality: z.array(EssentialityShare),
    categories: z.array(MonthCategory), // this month's spending, largest first
    largest: z.array(TransactionRead),
    transaction_count: z.int(), // non-transfer transactions posted this month
    review_count: z.int(), // of those, how many need review
  },
  'Everything the month view shows, on the shared aggregates definitions.',
)
export type MonthDetail = z.infer<typeof MonthDetail>
