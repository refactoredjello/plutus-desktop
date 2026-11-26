import { useState, type ReactNode } from 'react'
import type { Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useAccounts } from '@/features/settings/queries'
import { cn } from '@/lib/utils'
import { hasActiveFilters, PAGE_SIZE, type Filters } from './filters'
import { useCategories, useTransactions } from './queries'
import { TransactionRow } from './TransactionRow'

type Txn = Schemas['TransactionRead']

export function TransactionsTable({
  filters,
  onChange,
  visible,
  action,
  empty,
}: {
  filters: Filters
  onChange: (patch: Partial<Filters>) => void
  /** Hide rows that fail this test (rows with an open "Make this a rule" offer stay until it is answered). */
  visible?: (t: Txn) => boolean
  /** Optional trailing column, e.g. the review queue's "Looks right". */
  action?: { header: string; render: (t: Txn) => ReactNode }
  /** Replaces the default empty message. */
  empty?: ReactNode
}) {
  const txns = useTransactions(filters)
  const [kept, setKept] = useState<ReadonlySet<number>>(new Set())
  // Latest copy of every row seen, so a kept row can outlive a refetch that no longer returns it.
  const page = txns.data
  const [seen, setSeen] = useState<ReadonlyMap<number, Txn>>(new Map())
  const [seenFrom, setSeenFrom] = useState(page)
  if (page !== seenFrom) {
    setSeenFrom(page)
    if (page) setSeen((prev) => new Map([...prev, ...page.items.map((t) => [t.id, t] as const)]))
  }
  const accounts = useAccounts()
  const categories = useCategories()
  const accountName = new Map((accounts.data ?? []).map((a) => [a.id, a.name]))

  if (txns.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {txns.error.message}
      </p>
    )
  }

  const keep = (id: number, on: boolean) =>
    setKept((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  let rows = page?.items ?? []
  if (visible) {
    const ids = new Set(rows.map((t) => t.id))
    const extra = [...kept].filter((id) => !ids.has(id)).flatMap((id) => seen.get(id) ?? [])
    rows = [...rows, ...extra]
      .filter((t) => visible(t) || kept.has(t.id))
      .sort((a, b) => b.posted_on.localeCompare(a.posted_on) || b.id - a.id)
  }
  const columns = action ? 7 : 6
  const from = page && page.total > 0 ? page.offset + 1 : 0
  const to = page ? page.offset + page.items.length : 0

  return (
    <div>
      <div className={cn('rounded-lg border', txns.isPlaceholderData && 'opacity-60')}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Essentiality</TableHead>
              <TableHead className="hidden xl:table-cell">Account</TableHead>
              {action && <TableHead className="text-right">{action.header}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!page
              ? Array.from({ length: 8 }, (_, i) => (
                  <TableRow key={i} data-testid="skeleton-row">
                    <TableCell colSpan={columns}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : rows.map((t) => (
                  <TransactionRow
                    key={t.id}
                    txn={t}
                    accountName={accountName.get(t.account_id) ?? '—'}
                    categories={categories.data ?? []}
                    action={action?.render(t)}
                    onKeep={(on) => keep(t.id, on)}
                  />
                ))}
          </TableBody>
        </Table>
        {page && rows.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            <p>
              {empty ??
                (hasActiveFilters(filters) ? 'No transactions match these filters.' : 'No transactions yet. Sync from Settings.')}
            </p>
          </div>
        )}
      </div>
      {page && page.total > 0 && (
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span className="tabular-nums">
            {from}–{to} of {page.total}
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={filters.page <= 1}
              onClick={() => onChange({ page: filters.page - 1 })}
            >
              Previous
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={page.offset + PAGE_SIZE >= page.total}
              onClick={() => onChange({ page: filters.page + 1 })}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
