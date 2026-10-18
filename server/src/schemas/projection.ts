/** Request and response schemas for the balance projection. */

import { z } from '@hono/zod-openapi'
import { Money, PlainDate } from './common.js'
import { model } from './model.js'

export const ProjectedMonth = model('ProjectedMonth', {
  month: z.string(), // YYYY-MM
  starting_balance: Money,
  recurring_income: Money,
  recurring_expenses: Money,
  manual_income: Money,
  manual_expenses: Money,
  variable_spending: Money,
  variable_income: Money, // trailing average of income not covered by confirmed recurring items
  projected_end_balance: Money,
})
export type ProjectedMonth = z.infer<typeof ProjectedMonth>

export const ProjectionRead = model('ProjectionRead', {
  as_of: PlainDate,
  current_balance: Money,
  months: z.array(ProjectedMonth),
  assumptions: z.array(z.string()),
})
export type ProjectionRead = z.infer<typeof ProjectionRead>
