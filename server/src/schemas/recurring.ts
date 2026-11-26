/** Request and response schemas for recurring charges. */

import { z } from '@hono/zod-openapi'
import { Money, MoneyInput, PlainDate } from './common.js'
import { Cadence, Essentiality, EstimateBasis, RecurrenceStatus } from './enums.js'
import { model, orNull, requestModel } from './model.js'

export const RecurringChargeRead = model('RecurringChargeRead', {
  id: z.int(),
  merchant_key: z.string(),
  name: z.string(), // the latest matching payee on the account, else the merchant key
  account_id: z.int(),
  amount: Money,
  cadence: Cadence,
  next_expected_date: PlainDate,
  last_seen_on: orNull(PlainDate),
  status: RecurrenceStatus,
  essentiality: orNull(Essentiality),
  amount_varies: z.boolean(), // true: `amount` is an estimate, the median of the last six bills
  next_amount: Money, // the estimate for next_expected_date; `amount` unless amount_varies
  estimate_basis: EstimateBasis, // how next_amount was estimated
  annual_cost: Money, // amount_varies with a year of history: the last 365 days' bills

})
export type RecurringChargeRead = z.infer<typeof RecurringChargeRead>

export const RecurringChargeCreate = requestModel(
  'RecurringChargeCreate',
  {
    transaction_id: z.int(),
    cadence: Cadence,
    amount_varies: z.boolean().optional(), // absent keeps the item's setting (off for a new one)
  },
  "Mark a transaction's merchant as recurring (confirmed) at the given cadence.",
)
export type RecurringChargeCreate = z.infer<typeof RecurringChargeCreate>

export const RecurringChargeUpdate = requestModel('RecurringChargeUpdate', {
  status: orNull(RecurrenceStatus).optional(),
  essentiality: orNull(Essentiality).optional(),
  amount: MoneyInput.nullable().optional(),
  cadence: orNull(Cadence).optional(),
  amount_varies: z.boolean().nullable().optional(),
})
export type RecurringChargeUpdate = z.infer<typeof RecurringChargeUpdate>
