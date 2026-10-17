/**
 * Savings suggestions (R8). Ports app/services/suggestions.py.
 *
 * Privacy boundary: the LLM sees only what this module builds. The SavingsContext holds
 * category labels, rounded-to-cent monthly totals, cadences, and goal numbers. Never merchant
 * keys, descriptions, account names, or balances.
 *
 * Every amount in the context is whole cents, as every Decimal Python put there had two places
 * (NUMERIC(14,2) columns, sums of them, or values quantized to 0.00), so the prompt spells
 * them the same.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { RuntimeDefaults } from '../config.js'
import type { Db } from '../db/index.js'
import {
  type Essentiality,
  type SuggestionStatus,
  categories,
  categorizations,
  merchantClassifications,
  recurrences,
  suggestions,
  transactions,
} from '../db/schema.js'
import type { Logger } from '../lib/log.js'
import { ZERO, cents } from '../lib/money.js'
import { NotFoundError } from '../lib/errors.js'
import type { CategorySpend, LLMProvider, RecurringSpend, SavingsContext } from '../providers/llm/types.js'
import type { SecretStore } from '../secrets.js'
import { categoryTotals } from './aggregates.js'
import { llmProvider } from './config.js'
import { type Goal, computeProgress, getGoal, previousCompleteMonths } from './goals.js'

export type Suggestion = typeof suggestions.$inferSelect

export const TOP_CATEGORIES = 15
export const HISTORY_MONTHS = 6
const SUGGESTIBLE: Essentiality[] = ['flexible', 'discretionary']
export const UNCATEGORIZED = 'Uncategorized'

/** What Python's Settings supplied: the way to build the configured provider. */
export interface LlmDeps {
  secrets: SecretStore
  defaults: RuntimeDefaults
  log?: Logger | undefined
}

/** Category label for a merchant: cache first, else its latest categorized transaction. */
function merchantLabel(db: Db, merchantKey: string): string {
  let label: string | null =
    db
      .select({ label: categories.label })
      .from(categories)
      .innerJoin(merchantClassifications, eq(merchantClassifications.category_id, categories.id))
      .where(eq(merchantClassifications.merchant_key, merchantKey))
      .get()?.label ?? null
  if (label === null) {
    label =
      db
        .select({ label: categories.label })
        .from(categories)
        .innerJoin(categorizations, eq(categorizations.category_id, categories.id))
        .innerJoin(transactions, eq(transactions.id, categorizations.transaction_id))
        .where(eq(transactions.merchant_key, merchantKey))
        .orderBy(desc(transactions.posted_on), desc(transactions.id))
        .limit(1)
        .get()?.label ?? null
  }
  return label || UNCATEGORIZED
}

export function buildContext(db: Db, goal: Goal): SavingsContext {
  const months = previousCompleteMonths(HISTORY_MONTHS)
  const spend = categoryTotals(db, months).filter((c) => c.category_id !== null)
  const categorySpend: CategorySpend[] = spend.slice(0, TOP_CATEGORIES).map((c) => ({
    label: c.label,
    monthly_totals: months.map((m) => (Object.hasOwn(c.monthly, m) ? (c.monthly[m] ?? ZERO) : ZERO)),
  }))

  const charges = db
    .select()
    .from(recurrences)
    .where(and(eq(recurrences.status, 'confirmed'), inArray(recurrences.essentiality, SUGGESTIBLE)))
    .orderBy(asc(recurrences.id))
    .all()
  const recurring: RecurringSpend[] = []
  for (const r of charges) {
    if (r.essentiality === null) continue
    recurring.push({
      category_label: merchantLabel(db, r.merchant_key),
      amount: cents(Math.abs(r.amount)),
      cadence: r.cadence,
      essentiality: r.essentiality,
    })
  }

  const progress = computeProgress(db, goal)
  const excluded = db
    .select({ text: suggestions.text })
    .from(suggestions)
    .where(and(eq(suggestions.goal_id, goal.id), eq(suggestions.status, 'dismissed')))
    .orderBy(asc(suggestions.id))
    .all()
    .map((s) => s.text)
  return {
    goal_target: goal.target_amount,
    months_left: progress.months_left,
    monthly_gap: cents(progress.required_monthly - progress.actual_monthly_average),
    categories: categorySpend,
    recurring,
    excluded_suggestions: excluded,
  }
}

export function listSuggestions(db: Db, goalId: number): Suggestion[] {
  getGoal(db, goalId)
  return db
    .select()
    .from(suggestions)
    .where(eq(suggestions.goal_id, goalId))
    .orderBy(desc(suggestions.created_at), desc(suggestions.id))
    .all()
}

/** Ask the LLM for suggestions. ProviderError propagates; nothing is stored then. */
export async function generateSuggestions(
  db: Db,
  goalId: number,
  settings: LlmDeps,
  provider: LLMProvider | null = null,
): Promise<Suggestion[]> {
  const goal = getGoal(db, goalId)
  const llm = provider ?? llmProvider(db, settings.secrets, settings.defaults, settings.log)
  // The provider call happens before any write, outside a transaction.
  const results = await llm.suggestSavings(buildContext(db, goal))
  const categoryIds = new Map<string, number>()
  const rows = db.select({ id: categories.id, label: categories.label }).from(categories).orderBy(desc(categories.id)).all()
  for (const { id, label } of rows) categoryIds.set(label, id)
  return db.transaction((t) =>
    results.map((r) =>
      t
        .insert(suggestions)
        .values({
          goal_id: goal.id,
          text: r.text,
          category_id: r.category_label ? (categoryIds.get(r.category_label) ?? null) : null,
          estimated_monthly_saving: r.estimated_monthly_saving,
        })
        .returning()
        .get(),
    ),
  )
}

export function updateSuggestion(db: Db, suggestionId: number, status: SuggestionStatus): Suggestion {
  const suggestion = db.select().from(suggestions).where(eq(suggestions.id, suggestionId)).get()
  if (suggestion === undefined) throw new NotFoundError(`Suggestion ${suggestionId} not found`)
  return db.update(suggestions).set({ status }).where(eq(suggestions.id, suggestionId)).returning().get()
}
