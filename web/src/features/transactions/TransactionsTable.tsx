import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import type { Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useAccounts } from '@/features/settings/queries'
import { MOTION, usePrefersReducedMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { hasActiveFilters, PAGE_SIZE, type Filters } from './filters'
import { useCategories, useTransactions } from './queries'
import { TransactionRow } from './TransactionRow'

type Txn = Schemas['TransactionRead']

const byDate = (a: Txn, b: Txn) => b.posted_on.localeCompare(a.posted_on) || b.id - a.id
const idsOf = (rows: Txn[]) => rows.map((t) => t.id).join()

/** Focus a row's own action (e.g. "Looks right"), or the row itself when it has none. */
function focusRow(body: HTMLElement | null, id: number) {
  const row = body?.querySelector<HTMLElement>(`tr[data-row-id="${id}"]`)
  const action = row?.querySelector<HTMLElement>('[data-row-action] button:not(:disabled)')
  ;(action ?? row)?.focus()
}

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
  const reduced = usePrefersReducedMotion()
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  // The row holding focus, kept through the blur that clearing it causes.
  const focusedId = useRef<number | null>(null)
  // Rows cleared from the list, still on screen while they fade out.
  const [leaving, setLeaving] = useState<ReadonlyMap<number, Txn>>(new Map())
  // What was on screen last, and for which filters and page.
  const [shown, setShown] = useState<{ key: string; rows: Txn[] }>({ key: '', rows: [] })
  // For each row just cleared, the row that should take focus if it had it.
  const [handoff, setHandoff] = useState<ReadonlyMap<number, number | null>>(new Map())

  let rows = page?.items ?? []
  if (visible) {
    const ids = new Set(rows.map((t) => t.id))
    const extra = [...kept].filter((id) => !ids.has(id)).flatMap((id) => seen.get(id) ?? [])
    rows = [...rows, ...extra].filter((t) => visible(t) || kept.has(t.id)).sort(byDate)
  }

  // In a list that drops resolved rows (the review queue), a row that disappears while the filters
  // and page stay the same was cleared: by an edit here or because the server no longer lists it.
  // It fades out, and focus moves on to the next row. A filter or page change just swaps the rows.
  const key = JSON.stringify(filters)
  if (visible && page && !txns.isPlaceholderData && (key !== shown.key || idsOf(rows) !== idsOf(shown.rows))) {
    setShown({ key, rows })
    const now = new Set(rows.map((t) => t.id))
    const cleared = key === shown.key ? shown.rows.filter((t) => !now.has(t.id)) : []
    if (cleared.length > 0) {
      if (!reduced) setLeaving((prev) => new Map([...prev, ...cleared.map((t) => [t.id, t] as const)]))
      setHandoff(
        new Map(
          cleared.map((t) => {
            const at = shown.rows.indexOf(t)
            const next = shown.rows.slice(at + 1).find((r) => now.has(r.id)) ?? shown.rows.slice(0, at).reverse().find((r) => now.has(r.id))
            return [t.id, next?.id ?? null] as const
          }),
        ),
      )
    }
  }

  useEffect(() => {
    if (leaving.size === 0) return
    const timer = setTimeout(() => setLeaving(new Map()), MOTION.exit)
    return () => clearTimeout(timer)
  }, [leaving])

  useEffect(() => {
    const from = focusedId.current
    const to = from === null ? undefined : handoff.get(from)
    if (to == null) return
    // Only when focus went nowhere (the cleared row took it along); never steal it from elsewhere.
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected && !active.closest('[data-leaving]')) return
    focusRow(bodyRef.current, to)
  }, [handoff])

  if (txns.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {txns.error.message}
      </p>
    )
  }

  const trackFocus = (e: FocusEvent<HTMLElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('tr[data-row-id]')
    focusedId.current = row ? Number(row.dataset.rowId) : null
  }
  const untrackFocus = (e: FocusEvent<HTMLElement>) => {
    // A blur to nowhere is the cleared row losing focus; keep tracking it.
    if (e.relatedTarget && !bodyRef.current?.contains(e.relatedTarget as Node)) focusedId.current = null
  }

  const keep = (id: number, on: boolean) =>
    setKept((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const present = new Set(rows.map((t) => t.id))
  const rendered = leaving.size === 0 ? rows : [...rows, ...[...leaving.values()].filter((t) => !present.has(t.id))].sort(byDate)
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
          <TableBody ref={bodyRef} onFocus={trackFocus} onBlur={untrackFocus}>
            {!page
              ? Array.from({ length: 8 }, (_, i) => (
                  <TableRow key={i} data-testid="skeleton-row">
                    <TableCell colSpan={columns}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : rendered.map((t) => (
                  <TransactionRow
                    key={t.id}
                    txn={t}
                    leaving={!present.has(t.id)}
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
