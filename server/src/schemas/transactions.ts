/** Ports app/schemas/transactions.py. */

import { z } from '@hono/zod-openapi'
import { Money, Page, PlainDate } from './common.js'
import { ClassificationSource, Confidence, Essentiality, RuleMatchType } from './enums.js'
import { model, nullableRef, refWithDefault, requestModel } from './model.js'

export const CategorizationRead = model('CategorizationRead', {
  category_id: z.int(),
  essentiality: nullableRef(Essentiality),
  source: ClassificationSource,
  confidence: Confidence,
})
export type CategorizationRead = z.infer<typeof CategorizationRead>

export const TransactionRead = model('TransactionRead', {
  id: z.int(),
  account_id: z.int(),
  posted_on: PlainDate,
  amount: Money,
  raw_description: z.string(),
  payee: z.string().nullable(),
  pending: z.boolean(),
  merchant_key: z.string().nullable(),
  note: z.string().nullable(),
  one_time: z.boolean(),
  is_transfer: z.boolean(),
  categorization: nullableRef(CategorizationRead),
})
export type TransactionRead = z.infer<typeof TransactionRead>

/** `Page[TransactionRead]`. */
export const TransactionPage = Page(TransactionRead, 'TransactionRead')
export type TransactionPage = z.infer<typeof TransactionPage>

export const TransactionUpdate = requestModel(
  'TransactionUpdate',
  {
    category_id: z.int().nullable().optional(),
    essentiality: nullableRef(Essentiality).optional(),
    note: z.string().max(500).nullable().optional(), // send "" or null to clear
    one_time: z.boolean().nullable().optional(), // excluded from the projection's trailing average
    save_as_rule: z.boolean().default(false),
    rule_match_type: refWithDefault(RuleMatchType, 'exact'),
  },
  'Manual override. Setting save_as_rule also creates a rule for the merchant key.',
)
export type TransactionUpdate = z.infer<typeof TransactionUpdate>
