/** Request and response schemas for transactions. */

import { z } from '@hono/zod-openapi'
import { Money, Page, PlainDate } from './common.js'
import { ClassificationSource, Confidence, Essentiality, RuleMatchType } from './enums.js'
import { RuleRead } from './categories.js'
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
  memo: z.string().nullable(),
  pending: z.boolean(),
  merchant_key: z.string().nullable(),
  note: z.string().nullable(),
  one_time: z.boolean(),
  is_transfer: z.boolean(),
  // Why it needs review beyond its categorization, e.g. pending past the sync's reach; else null.
  review_reason: z.string().nullable(),
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

export const RuleSuggestion = model(
  'RuleSuggestion',
  {
    match_type: RuleMatchType,
    pattern: z.string(), // the merchant key, for exact and prefix rules
    contains_pattern: z.string(), // the payee when the bank description contains it, else the description
    category_id: z.int().nullable(), // the transaction's current category
    essentiality: orNull(Essentiality),
  },
  'Defaults for a new rule built from a transaction.',
)
export type RuleSuggestion = z.infer<typeof RuleSuggestion>

export const TransactionRuleRead = model(
  'TransactionRuleRead',
  {
    rule: orNull(RuleRead), // the rule categorization picks for this transaction; never one for a transfer
    suggestion: RuleSuggestion,
  },
  'The rule that matches a transaction, if any, and defaults for a new one.',
)
export type TransactionRuleRead = z.infer<typeof TransactionRuleRead>
