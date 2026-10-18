/**
 * Deterministic LLM stand-in for tests and credential-free development.
 *
 * Records every call so privacy tests can assert on exactly what would have been sent.
 */

import type { Essentiality } from '../../db/schema.js'
import { cents } from '../../lib/money.js'
import type {
  LLMProvider,
  MerchantClassification,
  MerchantInput,
  SavingsContext,
  SavingsSuggestion,
} from './types.js'

const KEYWORDS: readonly (readonly [string, string, Essentiality])[] = [
  ['PAYROLL', 'INCOME_SALARY', 'essential'],
  ['COFFEE', 'FOOD_AND_DRINK_COFFEE', 'discretionary'],
  ['NETFLIX', 'ENTERTAINMENT_TV_AND_MOVIES', 'discretionary'],
  ['SPOTIFY', 'ENTERTAINMENT_MUSIC_AND_AUDIO', 'discretionary'],
  ['GROCER', 'FOOD_AND_DRINK_GROCERIES', 'essential'],
  ['MARKET', 'FOOD_AND_DRINK_GROCERIES', 'essential'],
  ['RENT', 'RENT_AND_UTILITIES_RENT', 'essential'],
  ['ELECTRIC', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY', 'essential'],
  ['SHELL', 'TRANSPORTATION_GAS', 'essential'],
  ['AMAZON', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', 'flexible'],
  ['RESTAURANT', 'FOOD_AND_DRINK_RESTAURANT', 'discretionary'],
]

export class FakeLLMProvider implements LLMProvider {
  readonly name = 'fake'
  readonly classifyCalls: MerchantInput[][] = []
  readonly suggestCalls: SavingsContext[] = []

  async classifyMerchants(items: readonly MerchantInput[]): Promise<MerchantClassification[]> {
    this.classifyCalls.push([...items])
    return items.map((item) => {
      const match = KEYWORDS.find(([keyword]) => item.merchant_key.includes(keyword))
      if (match) {
        return { merchant_key: item.merchant_key, detailed_category: match[1], essentiality: match[2], confidence: 'high' }
      }
      return {
        merchant_key: item.merchant_key,
        detailed_category: 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE',
        essentiality: 'flexible',
        confidence: 'low',
      }
    })
  }

  async suggestSavings(context: SavingsContext): Promise<SavingsSuggestion[]> {
    this.suggestCalls.push(context)
    const out: SavingsSuggestion[] = []
    for (const rec of context.recurring) {
      if (rec.essentiality === 'discretionary') {
        const text = `Review your ${rec.category_label} subscription (${rec.cadence}).`
        if (!context.excluded_suggestions.includes(text)) {
          out.push({ text, category_label: rec.category_label, estimated_monthly_saving: rec.amount })
        }
      }
    }
    if (out.length === 0) {
      out.push({ text: 'Set a weekly cap on dining out.', category_label: null, estimated_monthly_saving: cents(5000) })
    }
    return out
  }
}
