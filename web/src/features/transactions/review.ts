import type { Schemas } from '@/api/client'

export const ESSENTIALITIES: Schemas['Essentiality'][] = ['essential', 'flexible', 'discretionary']

/** Uncategorized, or classified with low/unknown confidence. */
export const needsReview = (t: Schemas['TransactionRead']) =>
  !t.categorization || t.categorization.confidence === 'low' || t.categorization.confidence === 'unknown'
