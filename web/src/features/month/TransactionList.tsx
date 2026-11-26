import { useTransactionPanel } from '@/app/transactionPanel'
import { useCategories } from '@/features/transactions/queries'
import { formatDate } from '@/lib/format'
import { formatMoney } from '@/lib/money'
import type { Schemas } from '@/api/client'

/** A month's transactions; each opens the transaction panel, which links on to Transactions. */
export function TransactionList({ rows }: { rows: readonly Schemas['TransactionRead'][] }) {
  const categories = useCategories()
  const panel = useTransactionPanel()
  const label = (id: number | undefined) => (id === undefined ? 'Uncategorized' : (categories.data?.find((c) => c.id === id)?.label ?? ''))
  return (
    <ul>
      {rows.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            onClick={() => panel.open(t)}
            className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-2.5 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="min-w-0">
              <span className="block truncate">{t.payee ?? t.raw_description}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {formatDate(t.posted_on)} · {label(t.categorization?.category_id)}
              </span>
            </span>
            <span className="text-right font-medium tabular-nums">{formatMoney(t.amount)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
