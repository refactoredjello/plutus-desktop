/** Ports app/schemas/manual_entries.py. */

import { z } from '@hono/zod-openapi'
import { Money, MoneyInput, PlainDate } from './common.js'
import { Recurrence } from './enums.js'
import { model, orNull, refWithDefault, requestModel } from './model.js'

export const ManualEntryRead = model('ManualEntryRead', {
  id: z.int(),
  amount: Money,
  description: z.string(),
  category_id: z.int().nullable(),
  due_date: PlainDate,
  recurrence: Recurrence,
  end_date: orNull(PlainDate),
  fulfilled_transaction_id: z.int().nullable(),
})
export type ManualEntryRead = z.infer<typeof ManualEntryRead>

export const ManualEntryCreate = requestModel('ManualEntryCreate', {
  amount: MoneyInput,
  description: z.string().min(1).max(255),
  category_id: z.int().nullable().optional(),
  due_date: PlainDate,
  recurrence: refWithDefault(Recurrence, 'none'),
  end_date: orNull(PlainDate).optional(),
})
export type ManualEntryCreate = z.infer<typeof ManualEntryCreate>

export const ManualEntryUpdate = requestModel('ManualEntryUpdate', {
  amount: MoneyInput.nullable().optional(),
  description: z.string().min(1).max(255).nullable().optional(),
  category_id: z.int().nullable().optional(),
  due_date: orNull(PlainDate).optional(),
  recurrence: orNull(Recurrence).optional(),
  end_date: orNull(PlainDate).optional(),
  fulfilled_transaction_id: z.int().nullable().optional(),
})
export type ManualEntryUpdate = z.infer<typeof ManualEntryUpdate>
