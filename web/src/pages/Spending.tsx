import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { PageHeader } from '@/app/PageHeader'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useByCategory } from '@/features/overview/queries'
import { BreakdownBars } from '@/features/spending/BreakdownBars'
import { BUCKETS, type Bucket, bucketLabel, currentMonth, isBucket, isMonth } from '@/features/spending/data'
import { addMonths, monthLabel } from '@/lib/dates'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'

export function SpendingPage() {
  const [params, setParams] = useSearchParams()
  const [current] = useState(currentMonth)
  const rawBucket = params.get('essentiality')
  const rawMonth = params.get('month')
  const bucket: Bucket = isBucket(rawBucket) ? rawBucket : 'discretionary'
  const month = isMonth(rawMonth) ? rawMonth : current
  const query = useByCategory(month, bucket)

  const months = Array.from({ length: 12 }, (_, i) => addMonths(current, -i))
  if (!months.includes(month)) months.push(month)
  const set = (patch: Partial<Record<'essentiality' | 'month', string>>) =>
    setParams({ essentiality: bucket, month, ...patch }, { replace: true })

  const total = query.data?.reduce((s, r) => s + Number(r.total), 0) ?? 0

  return (
    <div>
      <Link
        to="/"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to overview
      </Link>
      <PageHeader
        title="Spending breakdown"
        description="Categories within one essentiality bucket."
      />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Essentiality" className="flex gap-1">
          {BUCKETS.map((b) => (
            <Button
              key={b.value}
              size="sm"
              variant={bucket === b.value ? 'secondary' : 'ghost'}
              aria-pressed={bucket === b.value}
              onClick={() => set({ essentiality: b.value })}
            >
              {b.label}
            </Button>
          ))}
        </div>
        <Select value={month} onValueChange={(v) => v && set({ month: v })}>
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
      </div>

      {query.isPending ? (
        <Skeleton data-testid="spending-skeleton" className="h-64 w-full" />
      ) : query.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
          <p>Couldn’t load this breakdown. {query.error.message}</p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : query.data.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No spending in this bucket for {monthLabel(month, 'long')}
        </p>
      ) : (
        <div className={cn('viz', query.isPlaceholderData && 'opacity-60')}>
          <p className="mb-5 text-sm text-muted-foreground">
            {bucketLabel(bucket)} in {monthLabel(month, 'long')}
            <span className="mt-1 block font-heading text-3xl font-semibold tracking-tight text-foreground tabular-nums">
              {formatMoney(String(total))}
            </span>
          </p>
          <BreakdownBars rows={query.data} bucket={bucket} month={month} />
        </div>
      )}
    </div>
  )
}
