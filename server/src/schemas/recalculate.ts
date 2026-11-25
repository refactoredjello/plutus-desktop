/** Response schema for the local recalculation behind the Refresh button. */

import { z } from '@hono/zod-openapi'
import { model } from './model.js'

export const RecalculateRead = model(
  'RecalculateRead',
  {
    recategorized: z.int(), // non-manual categorizations a rule changed
    categorized: z.int(), // uncategorized transactions given a category (transfers, rules, merchant cache)
    recurring_changes: z.int(), // recurring charges detected or refreshed
  },
  'What a local recalculation changed. No bank request and no LLM.',
)
export type RecalculateRead = z.infer<typeof RecalculateRead>
