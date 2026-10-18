/**
 * Prompts and structured-output schemas shared by the LLM providers. test/prompts.test.ts pins
 * every string byte for byte against test/fixtures/llm_prompts.json, so a prompt change is
 * always deliberate.
 *
 * System prompts are built only from static data (the seeded taxonomy and fixed text), so they
 * are byte-identical across calls and Anthropic prompt caching can reuse them. Anything that
 * varies per call goes in the user message.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { MIGRATIONS_FOLDER } from '../../db/index.js'
import { CONFIDENCES, ESSENTIALITIES } from '../../db/schema.js'
import { type Cents, cents, formatMoney } from '../../lib/money.js'
import type {
  AmountBucket,
  MerchantClassification,
  MerchantInput,
  SavingsContext,
  SavingsSuggestion,
} from './types.js'

const ACRONYMS: Record<string, string> = { Tv: 'TV', Atm: 'ATM' }

// --- Structured output -------------------------------------------------------------------------

/** Unknown keys are ignored; every field is required. */
export const ClassifiedMerchant = z.object({
  merchant_key: z.string(),
  detailed_category: z.string(),
  essentiality: z.enum(ESSENTIALITIES),
  confidence: z.enum(CONFIDENCES),
})

export const ClassificationBatch = z.object({ items: z.array(ClassifiedMerchant) })
export type ClassificationBatch = z.infer<typeof ClassificationBatch>

export const SuggestedSaving = z.object({
  text: z.string(),
  category_label: z.string().nullable(),
  estimated_monthly_saving: z.number().nullable(),
})

export const SuggestionBatch = z.object({ suggestions: z.array(SuggestedSaving) })
export type SuggestionBatch = z.infer<typeof SuggestionBatch>

/** ClassificationBatch.model_json_schema(), the `format` the Ollama provider sends. */
export const CLASSIFICATION_BATCH_JSON_SCHEMA = {
  $defs: {
    ClassifiedMerchant: {
      properties: {
        merchant_key: { title: 'Merchant Key', type: 'string' },
        detailed_category: { title: 'Detailed Category', type: 'string' },
        essentiality: { $ref: '#/$defs/Essentiality' },
        confidence: { $ref: '#/$defs/Confidence' },
      },
      required: ['merchant_key', 'detailed_category', 'essentiality', 'confidence'],
      title: 'ClassifiedMerchant',
      type: 'object',
    },
    Confidence: {
      description: "Mirrors Plaid's confidence levels.",
      enum: [...CONFIDENCES],
      title: 'Confidence',
      type: 'string',
    },
    Essentiality: {
      enum: [...ESSENTIALITIES],
      title: 'Essentiality',
      type: 'string',
    },
  },
  properties: {
    items: { items: { $ref: '#/$defs/ClassifiedMerchant' }, title: 'Items', type: 'array' },
  },
  required: ['items'],
  title: 'ClassificationBatch',
  type: 'object',
} as const

/** SuggestionBatch.model_json_schema(), the `format` the Ollama provider sends. */
export const SUGGESTION_BATCH_JSON_SCHEMA = {
  $defs: {
    SuggestedSaving: {
      properties: {
        text: { title: 'Text', type: 'string' },
        category_label: { anyOf: [{ type: 'string' }, { type: 'null' }], title: 'Category Label' },
        estimated_monthly_saving: {
          anyOf: [{ type: 'number' }, { type: 'null' }],
          title: 'Estimated Monthly Saving',
        },
      },
      required: ['text', 'category_label', 'estimated_monthly_saving'],
      title: 'SuggestedSaving',
      type: 'object',
    },
  },
  properties: {
    suggestions: { items: { $ref: '#/$defs/SuggestedSaving' }, title: 'Suggestions', type: 'array' },
  },
  required: ['suggestions'],
  title: 'SuggestionBatch',
  type: 'object',
} as const

// --- Text helpers ------------------------------------------------------------------------------

/** Whitespace runs: ASCII whitespace, \x1c-\x1f, and the Unicode spaces. */
// oxlint-disable-next-line no-control-regex -- \x1c-\x1f count as whitespace.
const PY_WHITESPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/

/** Runs of whitespace become one space; leading and trailing whitespace goes. */
function collapseWhitespace(text: string): string {
  return text
    .split(PY_WHITESPACE)
    .filter((part) => part !== '')
    .join(' ')
}

/** First character upper case, the rest lower case. */
function capitalize(word: string): string {
  const [first = '', ...rest] = Array.from(word)
  return first.toUpperCase() + rest.join('').toLowerCase()
}

/** JSON with a one-space indent and every character outside printable ASCII escaped as \uXXXX. */
function pyJsonDumps(value: unknown): string {
  // JSON.stringify already escapes quotes, backslashes and control characters (lower-case
  // hex); what remains is every UTF-16 unit above "~".
  const text = JSON.stringify(value, null, 1)
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    out += code > 0x7e ? `\\u${code.toString(16).padStart(4, '0')}` : text.charAt(i)
  }
  return out
}

// --- Taxonomy and system prompts ---------------------------------------------------------------

/** Same labelling as migration 0002: FOOD_AND_DRINK_COFFEE -> 'Coffee'. */
export function labelFor(primary: string, detailed: string): string {
  const prefix = `${primary}_`
  const rest = detailed.startsWith(prefix) ? detailed.slice(prefix.length) : detailed
  const words = rest.toLowerCase().split('_')
  words[0] = capitalize(words[0] ?? '')
  return words.map((w) => ACRONYMS[capitalize(w)] ?? w).join(' ')
}

interface SeedRow {
  primary: string
  detailed: string
  description: string | null
}

let taxonomy: string | undefined

/**
 * The seeded taxonomy, one line per detailed category, sorted deterministically, read from
 * the migration seed.
 */
export function taxonomyText(): string {
  if (taxonomy === undefined) {
    const rows = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'seed', 'categories.json'), 'utf8')) as SeedRow[]
    const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
    const sorted = [...rows].sort((a, b) => compare(a.primary, b.primary) || compare(a.detailed, b.detailed))
    taxonomy = sorted
      .map((r) => {
        const description = collapseWhitespace(r.description || 'No further description.')
        return `- ${r.detailed} | ${labelFor(r.primary, r.detailed)} | ${description}`
      })
      .join('\n')
  }
  return taxonomy
}

const CLASSIFY_INSTRUCTIONS = `You classify bank-transaction merchants for a personal finance app. Each input describes one
merchant by a scrubbed, normalized merchant key (uppercase, no account numbers, dates,
reference ids or personal names), a coarse amount bucket, a direction (inflow means money
arriving, outflow means money leaving) and the kind of account it posted to. For every input,
choose exactly one detailed category from the taxonomy below and one essentiality label.

How to work:
- Copy merchant_key into the output exactly as given, character for character. Return one
  output item per input item, in the same order, with no extras and none missing.
- detailed_category must be one of the detailed names in the taxonomy, spelled exactly as
  listed (uppercase with underscores). Never invent a category. If nothing fits, use
  OTHER_OTHER and set confidence to low.
- Use the direction. Money arriving from an employer is INCOME_*; money arriving as a refund
  or reimbursement is usually TRANSFER_IN_* or the original spending category. Outflows are
  spending, bill payments or transfers.
- Use the account kind. A payment to a credit or loan account from checking is a transfer or
  loan payment; a charge on a credit account is ordinary spending.
- Keys such as ZELLE TO, ZELLE FROM or VENMO PAYMENT have had the counterparty removed on
  purpose. Classify them as person-to-person transfers (TRANSFER_OUT_TRANSFER_OUT_FROM_APPS,
  TRANSFER_IN_TRANSFER_IN_FROM_APPS or the account-transfer variants) and use low confidence,
  because the purpose is unknown.
- Prefer the most specific detailed category that clearly applies; fall back to a broader
  "other" category inside the right primary group when the specific one is uncertain.
- The amount bucket is a hint only. It never overrides what the merchant obviously is.

Confidence:
- very_high: a well-known merchant whose category is unambiguous.
- high: clear from the name, with small room for doubt.
- medium: a plausible reading, but the merchant could belong to another category.
- low: a guess from weak evidence. Low confidence flags the result for human review, so use
  it honestly rather than guessing with false certainty.

Essentiality, which tells the owner what could be cut to save money:
- essential: needed to live or work, and not realistically avoidable. Examples: rent or
  mortgage, utilities, basic groceries, health care, insurance, minimum debt payments,
  commuting, childcare, payroll and other income.
- flexible: needed in some form, but the amount could be lower by shopping around or
  changing habits. Examples: phone and internet plans, gas beyond commuting, household goods,
  clothing, pharmacy items, car maintenance, gym memberships used regularly.
- discretionary: could be cut without harming daily life. Examples: restaurants, coffee
  shops, bars, streaming and music subscriptions, entertainment, hobbies, travel, gifts,
  most online shopping.
Money-in and pure transfers (INCOME_*, TRANSFER_IN_*, TRANSFER_OUT_*) are essential by
convention, because they are not spending that can be trimmed.

Worked examples (merchant key, direction, account kind -> category, essentiality, confidence):
- BLUE BOTTLE COFFEE OAKLAND CA, outflow, credit -> FOOD_AND_DRINK_COFFEE, discretionary, high
- TRADER JOE S OAKLAND CA, outflow, credit -> FOOD_AND_DRINK_GROCERIES, essential, very_high
- NETFLIX.COM CA, outflow, credit -> ENTERTAINMENT_TV_AND_MOVIES, discretionary, very_high
- ACME CORP PAYROLL, inflow, checking -> INCOME_SALARY, essential, high
- PG&E WEB ONLINE, outflow, checking -> RENT_AND_UTILITIES_GAS_AND_ELECTRICITY, essential, high
- AMZN MKTP US, outflow, credit -> GENERAL_MERCHANDISE_ONLINE_MARKETPLACES, flexible, medium
- ZELLE TO, outflow, checking -> TRANSFER_OUT_TRANSFER_OUT_FROM_APPS, essential, low
- UNRECOGNIZABLE MERCHANT NAME, outflow, credit -> OTHER_OTHER, flexible, low

Taxonomy. Each line is: detailed name | label | description.
`

const SAVINGS_INSTRUCTIONS = `You help one person save toward a financial goal. You receive aggregated spending data only:
monthly totals per category (oldest month first), recurring charges described by category and
cadence with an essentiality label, the goal target, the months left and the monthly gap that
must still be saved. Merchant names, account names and personal details are never provided,
and you must not guess or invent them.

Essentiality labels: essential means needed to live or work; flexible means needed but could
be made cheaper; discretionary means could be cut.

Rules:
- Ground every suggestion in the numbers provided. Refer to categories by their label and to
  amounts as dollars per month. Do not cite figures that are not in the input.
- Favor discretionary and flexible spending. Never suggest cutting essential spending, except
  to compare prices for the same service.
- Each suggestion is one or two sentences, specific and actionable, and states a realistic
  estimated monthly saving in dollars when the data supports one; otherwise leave it empty.
- category_label must be one of the provided category labels, or empty if the suggestion
  spans several categories.
- Do not repeat or rephrase any suggestion listed under excluded_suggestions; the owner has
  already dismissed those.
- If the monthly gap is zero or negative, the goal is on track: say so briefly and give at
  most one optional idea. Otherwise return between 3 and 6 suggestions, highest saving first.
`

export function classifySystemPrompt(): string {
  return CLASSIFY_INSTRUCTIONS + taxonomyText()
}

export function savingsSystemPrompt(): string {
  return SAVINGS_INSTRUCTIONS
}

// --- User messages -----------------------------------------------------------------------------

/** Rendered without 4+ digit runs so that nothing in a payload resembles an account number. */
export const BUCKET_TEXT: Record<AmountBucket, string> = {
  '<10': 'under $10',
  '10-50': '$10 to $50',
  '50-200': '$50 to $200',
  '200-1000': '$200 to $1k',
  '>1000': 'over $1k',
}

export function classifyUserMessage(items: readonly MerchantInput[]): string {
  const payload = items.map((i) => ({
    merchant_key: i.merchant_key,
    amount_bucket: BUCKET_TEXT[i.amount_bucket],
    direction: i.direction,
    account_kind: i.account_kind,
  }))
  return `Classify these merchants:\n${pyJsonDumps(payload)}`
}

/**
 * Money is written as a two-place decimal string ("123.40"): every amount in the context is
 * whole cents, so formatMoney gives it.
 */
export function savingsUserMessage(context: SavingsContext): string {
  const payload = {
    goal_target: formatMoney(context.goal_target),
    months_left: context.months_left,
    monthly_gap: formatMoney(context.monthly_gap),
    categories: context.categories.map((c) => ({
      label: c.label,
      monthly_totals: c.monthly_totals.map(formatMoney),
    })),
    recurring: context.recurring.map((r) => ({
      category_label: r.category_label,
      amount: formatMoney(r.amount),
      cadence: r.cadence,
      essentiality: r.essentiality,
    })),
    excluded_suggestions: [...context.excluded_suggestions],
  }
  return `Suggest savings for this situation:\n${pyJsonDumps(payload)}`
}

// --- Results -----------------------------------------------------------------------------------

export function toClassifications(batch: ClassificationBatch): MerchantClassification[] {
  return batch.items.map((i) => ({
    merchant_key: i.merchant_key,
    detailed_category: i.detailed_category,
    essentiality: i.essentiality,
    confidence: i.confidence,
  }))
}

/**
 * A float from the model to cents: the exact binary value of the float rounded half to even
 * to two places. toFixed(100) exposes that exact value (every double that can round to a
 * non-zero cent has at most 100 fraction digits).
 */
function floatToCents(value: number): Cents {
  // oxlint-disable-next-line number-arg-out-of-range -- ES2018 raised the toFixed limit to 100.
  const exact = Math.abs(value).toFixed(100)
  const [whole = '', frac = ''] = exact.split('.')
  if (!/^\d+$/.test(whole)) throw new RangeError(`Saving out of range: ${value}`)
  let n = Number(whole + frac.slice(0, 2))
  const rest = frac.slice(2)
  const first = rest.charAt(0)
  const tail = /[1-9]/.test(rest.slice(1))
  if (first > '5' || (first === '5' && (tail || n % 2 === 1))) n += 1
  return cents(value < 0 ? -n : n)
}

export function toSuggestions(batch: SuggestionBatch): SavingsSuggestion[] {
  return batch.suggestions.map((s) => ({
    text: s.text,
    category_label: s.category_label,
    estimated_monthly_saving: s.estimated_monthly_saving === null ? null : floatToCents(s.estimated_monthly_saving),
  }))
}
