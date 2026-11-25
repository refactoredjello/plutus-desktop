import { Link } from 'react-router'
import { useCategories } from '@/features/transactions/queries'
import { monthEnd } from '@/lib/dates'
import { formatDate } from '@/lib/format'
import { formatMoney } from '@/lib/money'
import type { Schemas } from '@/api/client'
import { transactionLink } from './data'

/** A month's transactions, each linking to Transactions filtered to its payee and month. */
export function TransactionList({ month, rows }: { month: string; rows: readonly Schemas['TransactionRead'][] }) {
  const categories = useCategories()
  const last = monthEnd(month)
  const label = (id: number | undefined) => (id === undefined ? 'Uncategorized' : (categories.data?.find((c) => c.id === id)?.label ?? ''))
  return (
    <ul>
      {rows.map((t) => (
        <li key={t.id}>
          <Link
            to={transactionLink(t, month, last)}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-2.5 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="min-w-0">
              <span className="block truncate">{t.payee ?? t.raw_description}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {formatDate(t.posted_on)} · {label(t.categorization?.category_id)}
              </span>
            </span>
            <span className="text-right font-medium tabular-nums">{formatMoney(t.amount)}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
