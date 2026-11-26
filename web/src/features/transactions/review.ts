import type { Schemas } from '@/api/client'

export const ESSENTIALITIES: Schemas['Essentiality'][] = ['essential', 'flexible', 'discretionary']

/** Uncategorized, classified with low/unknown confidence, or flagged by the server (review_reason). */
export const needsReview = (t: Schemas['TransactionRead']) =>
  !t.categorization || t.categorization.confidence === 'low' || t.categorization.confidence === 'unknown' || t.review_reason !== null
