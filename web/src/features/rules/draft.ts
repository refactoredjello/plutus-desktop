import type { Schemas } from '@/api/client'
import type { RuleMatchType } from '@/features/transactions/RuleMatchSelect'

/** A rule being created or edited. */
export interface RuleDraft {
  match_type: RuleMatchType
  pattern: string
  category_id: number | null
  essentiality: Schemas['Essentiality'] | null
}

/** A saved rule as a draft to edit. */
export const ruleDraft = (r: Schemas['RuleRead']): RuleDraft => ({
  match_type: r.match_type,
  pattern: r.pattern,
  category_id: r.category_id,
  essentiality: r.essentiality,
})

/** The request body for a complete draft, or null while the pattern or category is missing. */
export function ruleBody(draft: RuleDraft): Schemas['RuleCreate'] | null {
  const pattern = draft.pattern.trim()
  if (!pattern || draft.category_id === null) return null
  const body: Schemas['RuleCreate'] = { match_type: draft.match_type, pattern, category_id: draft.category_id }
  if (draft.essentiality) body.essentiality = draft.essentiality
  return body
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** "Matches 14 transactions; 2 set by hand stay as they are." */
export function matchCountText({ matches, manual }: Schemas['RulePreviewRead']): string {
  const head = `Matches ${matches} ${plural(matches, 'transaction', 'transactions')}`
  if (manual === 0) return `${head}.`
  return `${head}; ${manual} set by hand ${plural(manual, 'stays as it is', 'stay as they are')}.`
}
