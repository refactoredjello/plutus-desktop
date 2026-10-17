/** Ports app/schemas/accounts.py. */

import { z } from '@hono/zod-openapi'
import { DateTime, Money } from './common.js'
import { AccountType } from './enums.js'
import { model } from './model.js'

export const AccountRead = model('AccountRead', {
  id: z.int(),
  name: z.string(),
  type: AccountType,
  institution_name: z.string().nullable(),
  currency: z.string(),
  is_active: z.boolean(),
  balance: Money.nullable(),
  available: Money.nullable(),
  balance_as_of: DateTime.nullable(),
})
export type AccountRead = z.infer<typeof AccountRead>
