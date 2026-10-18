/** Request and response schemas for what changed. */

import { z } from '@hono/zod-openapi'
import { Money, PlainDate } from './common.js'
import { model, requestModel } from './model.js'

export const ChangeItem = model('ChangeItem', {
  signal: z.string(), // "S1".."S9"
  key: z.string(), // dismissal key, stable for the underlying fact
  text: z.string(), // the full sentence
  amount: Money.nullable(), // the dollar figure the sentence leads with, for emphasis
  href: z.string(), // frontend route with query parameters
})
export type ChangeItem = z.infer<typeof ChangeItem>

export const ChangesRead = model('ChangesRead', {
  as_of: PlainDate,
  average_months: z.int(), // prior months with activity behind the comparisons (0-3)
  items: z.array(ChangeItem), // sorted; capped at 7 unless all=true
  hidden: z.int(), // items beyond the cap
})
export type ChangesRead = z.infer<typeof ChangesRead>

export const DismissChange = requestModel('DismissChange', {
  key: z.string().min(1).max(255),
})
export type DismissChange = z.infer<typeof DismissChange>
