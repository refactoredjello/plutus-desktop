import { Skeleton } from '@/components/ui/skeleton'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { Filters } from './filters'
import { useTransactionSummary } from './queries'

/**
 * One line over the table for every row the filters match, not just this page. Pending rows are
 * counted but are in neither sum, as in every total; the line says how many.
 */
export function TransactionsSummary({ filters }: { filters: Filters }) {
  const summary = useTransactionSummary(filters)
  const s = summary.data
  if (summary.isError) return null
  if (!s) return <Skeleton className="mb-3 h-5 w-72 max-w-full" />
  const parts = [
    `${s.count} ${s.count === 1 ? 'transaction' : 'transactions'}`,
    `${formatMoney(s.spent)} spent`,
    `${formatMoney(s.received)} in`,
  ]
  if (s.pending_count > 0) parts.push(`${s.pending_count} pending, not in totals`)
  return (
    <p
      data-testid="transactions-summary"
      className={cn('mb-3 text-sm text-muted-foreground tabular-nums', summary.isPlaceholderData && 'opacity-60')}
    >
      {parts.join(' \u00b7 ')}
    </p>
  )
}
