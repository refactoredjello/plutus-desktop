/** Ports app/schemas/goals.py. */

import { z } from '@hono/zod-openapi'
import { DateTime, Money, PlainDate } from './common.js'
import { SuggestionStatus } from './enums.js'
import { model, nullableRef, requestModel } from './model.js'

/** `Money = Field(gt=0)`. */
const PositiveMoney = Money.refine((value) => !value.startsWith('-') && /[1-9]/.test(value), {
  message: 'Input should be greater than 0',
})

export const GoalProgress = model('GoalProgress', {
  saved_so_far: Money,
  remaining: Money,
  months_left: z.int(),
  required_monthly: Money,
  actual_monthly_average: Money,
  on_track: z.boolean(),
})
export type GoalProgress = z.infer<typeof GoalProgress>

export const GoalRead = model('GoalRead', {
  id: z.int(),
  name: z.string(),
  target_amount: Money,
  target_date: PlainDate,
  starting_amount: Money,
  is_active: z.boolean(),
  progress: nullableRef(GoalProgress),
})
export type GoalRead = z.infer<typeof GoalRead>

export const GoalCreate = requestModel('GoalCreate', {
  name: z.string().min(1).max(255),
  target_amount: PositiveMoney,
  target_date: PlainDate,
})
export type GoalCreate = z.infer<typeof GoalCreate>

export const GoalUpdate = requestModel('GoalUpdate', {
  name: z.string().min(1).max(255).nullable().optional(),
  target_amount: PositiveMoney.nullable().optional(),
  target_date: PlainDate.nullable().optional(),
  is_active: z.boolean().nullable().optional(),
})
export type GoalUpdate = z.infer<typeof GoalUpdate>

export const SuggestionRead = model('SuggestionRead', {
  id: z.int(),
  goal_id: z.int(),
  text: z.string(),
  category_id: z.int().nullable(),
  estimated_monthly_saving: Money.nullable(),
  status: SuggestionStatus,
  created_at: DateTime,
})
export type SuggestionRead = z.infer<typeof SuggestionRead>

export const SuggestionUpdate = requestModel('SuggestionUpdate', {
  status: SuggestionStatus,
})
export type SuggestionUpdate = z.infer<typeof SuggestionUpdate>
