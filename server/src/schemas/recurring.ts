/** Ports app/schemas/recurring.py. */

import { z } from '@hono/zod-openapi'
import { Money, MoneyInput, PlainDate } from './common.js'
import { Cadence, Essentiality, RecurrenceStatus } from './enums.js'
import { model, orNull, requestModel } from './model.js'

export const RecurringChargeRead = model('RecurringChargeRead', {
  id: z.int(),
  merchant_key: z.string(),
  account_id: z.int(),
  amount: Money,
  cadence: Cadence,
  next_expected_date: PlainDate,
  last_seen_on: orNull(PlainDate),
  status: RecurrenceStatus,
  essentiality: orNull(Essentiality),
  annual_cost: Money,
})
export type RecurringChargeRead = z.infer<typeof RecurringChargeRead>

export const RecurringChargeCreate = requestModel(
  'RecurringChargeCreate',
  {
    transaction_id: z.int(),
    cadence: Cadence,
  },
  "Mark a transaction's merchant as recurring (confirmed) at the given cadence.",
)
export type RecurringChargeCreate = z.infer<typeof RecurringChargeCreate>

export const RecurringChargeUpdate = requestModel('RecurringChargeUpdate', {
  status: orNull(RecurrenceStatus).optional(),
  essentiality: orNull(Essentiality).optional(),
  amount: MoneyInput.nullable().optional(),
  cadence: orNull(Cadence).optional(),
})
export type RecurringChargeUpdate = z.infer<typeof RecurringChargeUpdate>
