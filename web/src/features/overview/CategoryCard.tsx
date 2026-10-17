import { useState } from 'react'
import { Link } from 'react-router'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { addMonths, monthKey, monthLabel } from '@/lib/dates'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { ChartCard } from './ChartCard'
import { topCategories } from './data'
import { useByCategory } from './queries'

export function CategoryCard() {
  const [current] = useState(() => monthKey(new Date()))
  const [month, setMonth] = useState(current)
  const query = useByCategory(month)
  const months = Array.from({ length: 12 }, (_, i) => addMonths(current, -i))

  return (
    <ChartCard
      title="Spending by category"
      description="Select a category to see its transactions."
      query={query}
      isEmpty={(d) => d.length === 0}
      height={240}
      action={
        <Select value={month} onValueChange={(v) => v && setMonth(v)}>
          <SelectTrigger size="sm" aria-label="Month" className="w-40">
            <SelectValue>{monthLabel(month, 'long')}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {months.map((m) => (
              <SelectItem key={m} value={m}>
                {monthLabel(m, 'long')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {(data) => {
        const rows = topCategories(data, month)
        const max = Math.max(...rows.map((r) => r.total), 1)
        return (
          <ul className={cn('space-y-3', query.isPlaceholderData && 'opacity-60')}>
            {rows.map((r) => {
              const content = (
                <>
                  <span className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="truncate">{r.label}</span>
                    <span className="font-medium tabular-nums">{formatMoney(String(r.total))}</span>
                  </span>
                  <span className="mt-1 block h-2 rounded-full bg-muted">
                    <span
                      className="block h-2 rounded-r-[4px] rounded-l-full"
                      style={{ width: `${(r.total / max) * 100}%`, background: r.muted ? 'var(--viz-other)' : 'var(--viz-bar)' }}
                    />
                  </span>
                </>
              )
              return (
                <li key={r.key}>
                  {r.href ? (
                    <Link
                      to={r.href}
                      className="-mx-2 block rounded-md px-2 py-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {content}
                    </Link>
                  ) : (
                    <div className="-mx-2 px-2 py-1">{content}</div>
                  )}
                </li>
              )
            })}
          </ul>
        )
      }}
    </ChartCard>
  )
}
