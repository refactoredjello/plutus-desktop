/**
 * LLM provider interface.
 *
 * Privacy invariant: inputs to these methods are built only by services/scrub.ts and
 * services/suggestions.ts. Providers must never receive raw descriptions, balances,
 * account names, or the owner's name.
 *
 * Field names stay snake_case because prompts serialise them; methods are async because the
 * HTTP clients are.
 */

import type { Confidence, Essentiality } from '../../db/schema.js'
import type { Cents } from '../../lib/money.js'

export const AMOUNT_BUCKETS = ['<10', '10-50', '50-200', '200-1000', '>1000'] as const
export type AmountBucket = (typeof AMOUNT_BUCKETS)[number]

export const ACCOUNT_KINDS = ['checking', 'savings', 'credit', 'loan', 'other'] as const
export type AccountKind = (typeof ACCOUNT_KINDS)[number]

export type Direction = 'inflow' | 'outflow'

export interface MerchantInput {
  /** Scrubbed, normalized. */
  readonly merchant_key: string
  readonly amount_bucket: AmountBucket
  readonly direction: Direction
  readonly account_kind: AccountKind
}

export interface MerchantClassification {
  readonly merchant_key: string
  /** A Plaid detailed category, e.g. FOOD_AND_DRINK_COFFEE. */
  readonly detailed_category: string
  readonly essentiality: Essentiality
  readonly confidence: Confidence
}

export interface CategorySpend {
  readonly label: string
  /** Oldest first. */
  readonly monthly_totals: readonly Cents[]
}

export interface RecurringSpend {
  /** Merchant names are withheld. */
  readonly category_label: string
  readonly amount: Cents
  readonly cadence: string
  readonly essentiality: Essentiality
}

export interface SavingsContext {
  readonly goal_target: Cents
  readonly months_left: number
  /** Extra saving needed per month; <= 0 means on track. */
  readonly monthly_gap: Cents
  readonly categories: readonly CategorySpend[]
  readonly recurring: readonly RecurringSpend[]
  readonly excluded_suggestions: readonly string[]
}

export interface SavingsSuggestion {
  readonly text: string
  readonly category_label: string | null
  readonly estimated_monthly_saving: Cents | null
}

export interface LLMProvider {
  readonly name: string
  classifyMerchants(items: readonly MerchantInput[]): Promise<MerchantClassification[]>
  suggestSavings(context: SavingsContext): Promise<SavingsSuggestion[]>
}
