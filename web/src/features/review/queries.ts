import { emptyFilters } from '@/features/transactions/filters'
import { useTransactions } from '@/features/transactions/queries'

export const reviewFilters = { ...emptyFilters, review: true }

/**
 * How many transactions need review. One limit-1 page of `needs_review=true`, read for its `total`.
 * Lives under the ['transactions'] key prefix, so every edit and the Review page's own refetch keep it fresh.
 */
export const useReviewCount = () => {
  const query = useTransactions(reviewFilters, 1)
  return { ...query, count: query.data?.total ?? 0 }
}
