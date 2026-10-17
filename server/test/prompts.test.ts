/**
 * Prompts and structured-output schemas. Ports the prompt tests in api/tests/test_llm_providers.py
 * and checks byte equality with the Python builders (plan 5.10).
 *
 * `fixtures/llm_prompts.json` was generated from api/app/providers/llm/prompts.py at port time
 * (brief 1D); the parity harness compares the live text. Money in the savings contexts is cents;
 * the generator turned each into the two-place Decimal suggestions.build_context passes, so
 * str(Decimal) there is the spelling Python sends.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Essentiality } from '../src/db/schema.js'
import { type Cents, cents } from '../src/lib/money.js'
import {
  CLASSIFICATION_BATCH_JSON_SCHEMA,
  ClassificationBatch,
  SUGGESTION_BATCH_JSON_SCHEMA,
  SuggestionBatch,
  classifySystemPrompt,
  classifyUserMessage,
  labelFor,
  savingsSystemPrompt,
  savingsUserMessage,
  taxonomyText,
  toClassifications,
  toSuggestions,
} from '../src/providers/llm/prompts.js'
import type { AccountKind, AmountBucket, Direction, MerchantInput, SavingsContext } from '../src/providers/llm/types.js'
import { FIXTURES } from './setup.js'

interface FixtureContext {
  goal_target: number
  months_left: number
  monthly_gap: number
  categories: [string, number[]][]
  recurring: [string, number, string, Essentiality][]
  excluded: string[]
}

interface PromptFixture {
  classify_system_prompt: string
  savings_system_prompt: string
  classification_batch_schema: unknown
  suggestion_batch_schema: unknown
  classify_user_messages: { items: [string, AmountBucket, Direction, AccountKind][]; text: string }[]
  savings_user_messages: { context: FixtureContext; text: string }[]
  to_suggestions: { value: number; decimal: string; stored: string; cents: number }[]
}

const PY = JSON.parse(readFileSync(join(FIXTURES, 'llm_prompts.json'), 'utf8')) as PromptFixture

const ITEMS: MerchantInput[] = [
  { merchant_key: 'BLUE BOTTLE COFFEE OAKLAND CA', amount_bucket: '<10', direction: 'outflow', account_kind: 'credit' },
  { merchant_key: 'ACME CORP PAYROLL', amount_bucket: '>1000', direction: 'inflow', account_kind: 'checking' },
]

function items(rows: [string, AmountBucket, Direction, AccountKind][]): MerchantInput[] {
  return rows.map(([merchant_key, amount_bucket, direction, account_kind]) => ({
    merchant_key,
    amount_bucket,
    direction,
    account_kind,
  }))
}

function context(c: FixtureContext): SavingsContext {
  return {
    goal_target: cents(c.goal_target),
    months_left: c.months_left,
    monthly_gap: cents(c.monthly_gap),
    categories: c.categories.map(([label, totals]) => ({ label, monthly_totals: totals.map(cents) })),
    recurring: c.recurring.map(([category_label, amount, cadence, essentiality]) => ({
      category_label,
      amount: cents(amount),
      cadence,
      essentiality,
    })),
    excluded_suggestions: c.excluded,
  }
}

/** The seed CSV's rows; primary and detailed never contain commas. */
function seedRows(): { primary: string; detailed: string }[] {
  const lines = readFileSync(join(FIXTURES, 'plaid_pfc_v2.csv'), 'utf8').trimEnd().split(/\r?\n/).slice(1)
  return lines.map((line) => {
    const [primary = '', detailed = ''] = line.split(',')
    return { primary, detailed }
  })
}

describe('byte equality with the Python prompts', () => {
  it('classify system prompt', () => {
    expect(classifySystemPrompt()).toBe(PY.classify_system_prompt)
  })

  it('savings system prompt', () => {
    expect(savingsSystemPrompt()).toBe(PY.savings_system_prompt)
  })

  it.each(PY.classify_user_messages.map((m, i) => [i, m] as const))('classify user message %i', (_, m) => {
    expect(classifyUserMessage(items(m.items))).toBe(m.text)
  })

  it.each(PY.savings_user_messages.map((m, i) => [i, m] as const))('savings user message %i', (_, m) => {
    expect(savingsUserMessage(context(m.context))).toBe(m.text)
  })

  it('Ollama format schemas match pydantic model_json_schema, key order included', () => {
    expect(JSON.stringify(CLASSIFICATION_BATCH_JSON_SCHEMA)).toBe(JSON.stringify(PY.classification_batch_schema))
    expect(JSON.stringify(SUGGESTION_BATCH_JSON_SCHEMA)).toBe(JSON.stringify(PY.suggestion_batch_schema))
  })
})

describe('prompt numbers', () => {
  // Python interpolates str(Decimal). Every Decimal suggestions.build_context passes is already
  // two places (NUMERIC(14,2) columns, or values quantized to 0.00), so formatMoney's spelling
  // is Python's. Spellings such as "12.5" or "-0.00" cannot reach the prompt there.
  it.each([
    [1250, '12.50'],
    [0, '0.00'],
    [-5, '-0.05'],
    [1, '0.01'],
    [-30000, '-300.00'],
    [123456789, '1234567.89'],
  ])('%i cents is spelled %s', (value, spelled) => {
    const text = savingsUserMessage({
      goal_target: cents(value),
      months_left: 1,
      monthly_gap: cents(value),
      categories: [{ label: 'X', monthly_totals: [cents(value)] }],
      recurring: [{ category_label: 'Y', amount: cents(value), cadence: 'monthly', essentiality: 'flexible' }],
      excluded_suggestions: [],
    })
    const payload = JSON.parse(text.split('\n').slice(1).join('\n')) as Record<string, unknown>
    expect(payload).toMatchObject({
      goal_target: spelled,
      monthly_gap: spelled,
      categories: [{ label: 'X', monthly_totals: [spelled] }],
      recurring: [{ amount: spelled }],
    })
  })

  it.each(PY.to_suggestions.map((s) => [s.value, s.decimal, s.cents] as const))(
    'a suggested saving of %d is stored as Python stores Decimal(%s): %i cents',
    (value, _decimal, expected) => {
      const [suggestion] = toSuggestions({
        suggestions: [{ text: 't', category_label: null, estimated_monthly_saving: value }],
      })
      expect(suggestion?.estimated_monthly_saving).toBe(expected)
    },
  )
})

describe('system prompt (test_llm_providers.py)', () => {
  it('lists the full taxonomy and is large enough to cache', () => {
    const prompt = classifySystemPrompt()
    const rows = seedRows()
    expect(rows).toHaveLength(127)
    for (const row of rows) expect(prompt).toContain(`- ${row.detailed} |`)
    for (const label of ['essential', 'flexible', 'discretionary']) expect(prompt).toContain(label)
    // Haiku 4.5 caches prefixes of 4096+ tokens; ~3.5 characters per token is conservative here.
    expect(prompt.length / 3.5).toBeGreaterThan(4096)
    expect(prompt).toBe(classifySystemPrompt())
  })

  it('sorts the taxonomy', () => {
    const names = taxonomyText()
      .split('\n')
      .map((line) => line.split(' | ')[0] ?? '')
    expect(names).toHaveLength(127)
    expect(names).toEqual([...names].sort()) // primary groups sort with their names
  })

  it('has no four-digit runs in the user message', () => {
    expect(classifyUserMessage(ITEMS)).not.toMatch(/\d{4,}/)
  })

  it('labels categories like the seed migration', () => {
    const seed = JSON.parse(
      readFileSync(new URL('../src/db/migrations/seed/categories.json', import.meta.url), 'utf8'),
    ) as { primary: string; detailed: string; label: string }[]
    for (const row of seed) expect(labelFor(row.primary, row.detailed)).toBe(row.label)
    expect(labelFor('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE')).toBe('Coffee')
    expect(labelFor('ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES')).toBe('TV and movies')
  })
})

describe('structured output', () => {
  const parsedItems = {
    items: [
      { merchant_key: 'BLUE BOTTLE COFFEE OAKLAND CA', detailed_category: 'FOOD_AND_DRINK_COFFEE', essentiality: 'discretionary', confidence: 'high' },
      { merchant_key: 'ACME CORP PAYROLL', detailed_category: 'INCOME_SALARY', essentiality: 'essential', confidence: 'very_high' },
    ],
  }

  it('maps a classification batch to classifications', () => {
    expect(toClassifications(ClassificationBatch.parse(parsedItems))).toEqual(parsedItems.items)
  })

  it('validates like the pydantic models', () => {
    expect(ClassificationBatch.safeParse({ items: [], extra: 1 })).toMatchObject({ success: true, data: { items: [] } })
    expect(ClassificationBatch.safeParse({}).success).toBe(false)
    expect(ClassificationBatch.safeParse({ items: [{ merchant_key: 'X' }] }).success).toBe(false)
    const shouting = { items: [{ ...parsedItems.items[0], essentiality: 'ESSENTIAL' }] }
    expect(ClassificationBatch.safeParse(shouting).success).toBe(false)
    expect(ClassificationBatch.safeParse({ items: [{ ...parsedItems.items[0], confidence: 'unknown' }] }).success).toBe(true)

    expect(SuggestionBatch.safeParse({ suggestions: [{ text: 'a', category_label: null, estimated_monthly_saving: null }] }).success).toBe(true)
    // category_label is required even though it may be null.
    expect(SuggestionBatch.safeParse({ suggestions: [{ text: 'a', estimated_monthly_saving: null }] }).success).toBe(false)
    expect(SuggestionBatch.safeParse({ suggestions: [{ text: 1, category_label: null, estimated_monthly_saving: null }] }).success).toBe(false)
  })

  it('maps suggestions, rounding the saving to cents', () => {
    const out = toSuggestions(
      SuggestionBatch.parse({
        suggestions: [
          { text: 'Cook at home twice a week.', category_label: 'Restaurants', estimated_monthly_saving: 40.5 },
          { text: 'Review subscriptions.', category_label: null, estimated_monthly_saving: null },
        ],
      }),
    )
    expect(out).toEqual([
      { text: 'Cook at home twice a week.', category_label: 'Restaurants', estimated_monthly_saving: 4050 as Cents },
      { text: 'Review subscriptions.', category_label: null, estimated_monthly_saving: null },
    ])
  })
})
