/** Request and response schemas for transactions. */

import { z } from '@hono/zod-openapi'
import { Money, Page, PlainDate } from './common.js'
import { ClassificationSource, Confidence, Essentiality, RuleMatchType } from './enums.js'
import { model, orNull, refWithDefault, requestModel } from './model.js'

export const CategorizationRead = model('CategorizationRead', {
  category_id: z.int(),
  essentiality: orNull(Essentiality),
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
  categorization: orNull(CategorizationRead),
})
export type TransactionRead = z.infer<typeof TransactionRead>

/** `Page[TransactionRead]`. */
export const TransactionPage = Page(TransactionRead, 'TransactionRead')
export type TransactionPage = z.infer<typeof TransactionPage>

export const TransactionUpdate = requestModel(
  'TransactionUpdate',
  {
    category_id: z.int().nullable().optional(),
    essentiality: orNull(Essentiality).optional(),
    note: z.string().max(500).nullable().optional(), // send "" or null to clear
    one_time: z.boolean().nullable().optional(), // excluded from the projection's trailing average
    save_as_rule: z.boolean().default(false),
    rule_match_type: refWithDefault(RuleMatchType, 'exact'),
    // Defaults to the merchant key (exact, prefix) or the payee or raw description (contains).
    rule_pattern: z.string().max(200).nullable().optional(),
  },
  'Manual override. Setting save_as_rule also creates a rule; rule_match_type and rule_pattern shape it.',
)
export type TransactionUpdate = z.infer<typeof TransactionUpdate>
