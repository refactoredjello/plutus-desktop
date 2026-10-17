/**
 * Port of api/tests/test_llm_providers.py (the prompt tests live in prompts.test.ts), plus tests
 * for the fake provider, which Python exercised only through other tests; those are read off
 * api/app/providers/llm/fake.py.
 */

import { describe, expect, it } from 'vitest'
import { cents } from '../src/lib/money.js'
import { FakeLLMProvider } from '../src/providers/llm/fake.js'
import type { MerchantInput, SavingsContext } from '../src/providers/llm/types.js'

const ITEMS: MerchantInput[] = [
  { merchant_key: 'BLUE BOTTLE COFFEE OAKLAND CA', amount_bucket: '<10', direction: 'outflow', account_kind: 'credit' },
  { merchant_key: 'ACME CORP PAYROLL', amount_bucket: '>1000', direction: 'inflow', account_kind: 'checking' },
]

const CONTEXT: SavingsContext = {
  goal_target: cents(500000),
  months_left: 6,
  monthly_gap: cents(30000),
  categories: [{ label: 'Restaurants', monthly_totals: [cents(20000), cents(25050)] }],
  recurring: [{ category_label: 'TV and movies', amount: cents(1549), cadence: 'monthly', essentiality: 'discretionary' }],
  excluded_suggestions: ['Cancel Netflix'],
}

function merchant(key: string): MerchantInput {
  return { merchant_key: key, amount_bucket: '10-50', direction: 'outflow', account_kind: 'credit' }
}

// --- fake -------------------------------------------------------------------------------------

describe('FakeLLMProvider', () => {
  it('classifies by the keyword table, in table order', async () => {
    const fake = new FakeLLMProvider()
    expect(fake.name).toBe('fake')
    const keys = [
      'ACME CORP PAYROLL',
      'BLUE BOTTLE COFFEE',
      'NETFLIX.COM',
      'SPOTIFY USA',
      'LOCAL GROCER',
      'FARMERS MARKET',
      'RENT PAYMENT',
      'CITY ELECTRIC',
      'SHELL OIL',
      'AMAZON MKTP',
      'RESTAURANT ROW',
      'MARKET COFFEE', // COFFEE comes before MARKET in the table
      'blue bottle coffee', // matching is case-sensitive
      'UNKNOWN VENDOR',
    ]
    const out = await fake.classifyMerchants(keys.map(merchant))
    expect(out.map((c) => [c.merchant_key, c.detailed_category, c.essentiality, c.confidence])).toEqual([
      ['ACME CORP PAYROLL', 'INCOME_SALARY', 'essential', 'high'],
      ['BLUE BOTTLE COFFEE', 'FOOD_AND_DRINK_COFFEE', 'discretionary', 'high'],
      ['NETFLIX.COM', 'ENTERTAINMENT_TV_AND_MOVIES', 'discretionary', 'high'],
      ['SPOTIFY USA', 'ENTERTAINMENT_MUSIC_AND_AUDIO', 'discretionary', 'high'],
      ['LOCAL GROCER', 'FOOD_AND_DRINK_GROCERIES', 'essential', 'high'],
      ['FARMERS MARKET', 'FOOD_AND_DRINK_GROCERIES', 'essential', 'high'],
      ['RENT PAYMENT', 'RENT_AND_UTILITIES_RENT', 'essential', 'high'],
      ['CITY ELECTRIC', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY', 'essential', 'high'],
      ['SHELL OIL', 'TRANSPORTATION_GAS', 'essential', 'high'],
      ['AMAZON MKTP', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', 'flexible', 'high'],
      ['RESTAURANT ROW', 'FOOD_AND_DRINK_RESTAURANT', 'discretionary', 'high'],
      ['MARKET COFFEE', 'FOOD_AND_DRINK_COFFEE', 'discretionary', 'high'],
      ['blue bottle coffee', 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE', 'flexible', 'low'],
      ['UNKNOWN VENDOR', 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE', 'flexible', 'low'],
    ])
  })

  it('records every classify call with a copy of the inputs', async () => {
    const fake = new FakeLLMProvider()
    const batch = [...ITEMS]
    await fake.classifyMerchants(batch)
    await fake.classifyMerchants([])
    batch.pop()
    expect(fake.classifyCalls).toEqual([ITEMS, []])
    expect(fake.suggestCalls).toEqual([])
  })

  it('suggests reviewing discretionary recurring charges that are not excluded', async () => {
    const fake = new FakeLLMProvider()
    const context: SavingsContext = {
      ...CONTEXT,
      recurring: [
        { category_label: 'TV and movies', amount: cents(1549), cadence: 'monthly', essentiality: 'discretionary' },
        { category_label: 'Gym', amount: cents(4000), cadence: 'monthly', essentiality: 'flexible' },
        { category_label: 'Music and audio', amount: cents(999), cadence: 'weekly', essentiality: 'discretionary' },
      ],
      excluded_suggestions: ['Review your Music and audio subscription (weekly).'],
    }
    expect(await fake.suggestSavings(context)).toEqual([
      { text: 'Review your TV and movies subscription (monthly).', category_label: 'TV and movies', estimated_monthly_saving: 1549 },
    ])
    expect(fake.suggestCalls).toEqual([context])
    expect(fake.classifyCalls).toEqual([])
  })

  it('falls back to a dining-out cap', async () => {
    const fake = new FakeLLMProvider()
    const context: SavingsContext = { ...CONTEXT, recurring: [], excluded_suggestions: [] }
    expect(await fake.suggestSavings(context)).toEqual([
      { text: 'Set a weekly cap on dining out.', category_label: null, estimated_monthly_saving: 5000 },
    ])
    const excluded: SavingsContext = { ...CONTEXT, excluded_suggestions: ['Review your TV and movies subscription (monthly).'] }
    expect((await fake.suggestSavings(excluded))[0]?.text).toBe('Set a weekly cap on dining out.')
  })
})
