import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { categoryLink, uncategorizedLink } from '@/features/overview/data'
import { monthEnd } from '@/lib/dates'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { categoryRowsSplit, compare, type Detail, monthName, signedMoney } from './data'

const COLS = 'grid grid-cols-[minmax(0,1fr)_5.5rem_5rem_2rem_1rem] items-center gap-x-2'

export function CategoryTable({ d }: { d: Detail }) {
  const [open, setOpen] = useState(false)
  const { shown, rest } = categoryRowsSplit(d.categories)
  const rows = open ? d.categories : shown
  const n = d.average_months
  return (
    <section aria-label="Spending by category">
      <div className={cn(COLS, 'border-b px-2 pb-2 text-xs text-muted-foreground')}>
        <span>Category</span>
        <span className="text-right">{monthName(d.month)}</span>
        <span className="text-right">{n >= 3 ? `vs ${n}-mo avg` : 'vs avg'}</span>
        <span className="text-right">Txns</span>
        <span />
      </div>
      <ul>
        {rows.map((c) => {
          const { tone, delta } = compare(Number(c.total), c.average === null ? null : Number(c.average))
          const vs = tone === 'up' || tone === 'down'
          return (
            <li key={c.category_id ?? 'uncategorized'}>
              <Link
                to={c.category_id === null ? uncategorizedLink(d.month) : categoryLink(c.category_id, d.month)}
                className={cn(COLS, 'rounded-md px-2 py-2.5 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring')}
              >
                <span className={cn('truncate', c.category_id === null && 'text-muted-foreground')}>{c.label}</span>
                <span className="text-right font-medium tabular-nums">{formatMoney(c.total)}</span>
                <span
                  className={cn(
                    'text-right text-xs tabular-nums',
                    !vs && 'text-muted-foreground',
                    tone === 'up' && 'text-destructive',
                    tone === 'down' && 'text-emerald-700 dark:text-emerald-400',
                  )}
                >
                  {vs ? signedMoney(delta) : '—'}
                </span>
                <span className="text-right text-xs text-muted-foreground tabular-nums">{c.count}</span>
                <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
              </Link>
            </li>
          )
        })}
      </ul>
      {rest.length > 0 && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full rounded-md px-2 py-2.5 text-left text-sm text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          … {rest.length} more {rest.length === 1 ? 'category' : 'categories'}
        </button>
      )}
      <p className="mt-3 border-t px-2 pt-3 text-sm">
        <Link
          to={`/transactions?${new URLSearchParams({ start: `${d.month}-01`, end: monthEnd(d.month) })}`}
          className="underline underline-offset-2 hover:text-foreground"
        >
          View all {d.transaction_count} transactions this month
        </Link>
      </p>
    </section>
  )
}
