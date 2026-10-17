/** Ports app/schemas/recurring.py. */

import { z } from '@hono/zod-openapi'
import { Money, PlainDate } from './common.js'
import { Cadence, Essentiality, RecurrenceStatus } from './enums.js'
import { model, nullableRef, requestModel } from './model.js'

export const RecurringChargeRead = model('RecurringChargeRead', {
  id: z.int(),
  merchant_key: z.string(),
  account_id: z.int(),
  amount: Money,
  cadence: Cadence,
  next_expected_date: PlainDate,
  last_seen_on: PlainDate.nullable(),
  status: RecurrenceStatus,
  essentiality: nullableRef(Essentiality),
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
  status: nullableRef(RecurrenceStatus).optional(),
  essentiality: nullableRef(Essentiality).optional(),
  amount: Money.nullable().optional(),
  cadence: nullableRef(Cadence).optional(),
})
export type RecurringChargeUpdate = z.infer<typeof RecurringChargeUpdate>
