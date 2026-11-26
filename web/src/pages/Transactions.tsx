import { PageHeader } from '@/app/PageHeader'
import { FilterBar } from '@/features/transactions/FilterBar'
import { useFilters } from '@/features/transactions/filters'
import { TransactionsSummary } from '@/features/transactions/TransactionsSummary'
import { TransactionsTable } from '@/features/transactions/TransactionsTable'

export function TransactionsPage() {
  const [filters, update] = useFilters()
  return (
    <div>
      <PageHeader title="Transactions" description="Search, filter, and recategorize." />
      <FilterBar filters={filters} onChange={update} />
      <TransactionsSummary filters={filters} />
      <TransactionsTable filters={filters} onChange={update} stickyHeader />
    </div>
  )
}
