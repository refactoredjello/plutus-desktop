/** `/month` shows the current month; `/month/YYYY-MM` a given one. */
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { CategoryTable } from '@/features/month/CategoryTable'
import type { Detail } from '@/features/month/data'
import { EssentialityBar } from '@/features/month/EssentialityBar'
import { MonthTiles } from '@/features/month/MonthTiles'
import { useMonthDetail } from '@/features/month/queries'
import { TransactionList } from '@/features/month/TransactionList'
import { currentMonth, isMonth } from '@/features/spending/data'
import { addMonths, monthLabel } from '@/lib/dates'

const arrow = 'inline-flex size-8 items-center justify-center rounded-md border text-muted-foreground'

function Status({ d }: { d: Detail }) {
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
      <span>{d.is_complete ? 'Complete month' : `In progress, day ${d.days_elapsed} of ${d.days_in_month}`}</span>
      {d.review_count > 0 && (
        <Link to="/review" className="underline underline-offset-2 hover:text-foreground">
          {d.review_count} to review
        </Link>
      )}
    </p>
  )
}

export function MonthPage() {
  const params = useParams()
  const [current] = useState(currentMonth)
  const month = params.month ?? current
  const valid = isMonth(month)
  const query = useMonthDetail(month, valid)
  const title = valid ? monthLabel(month, 'long') : 'Month'
  const d = query.data

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
          {d ? <Status d={d} /> : <p className="mt-1 h-5" />}
        </div>
        {valid && (
          <nav aria-label="Month navigation" className="flex gap-1">
            <Link to={`/month/${addMonths(month, -1)}`} aria-label="Previous month" className={`${arrow} hover:bg-muted`}>
              <ArrowLeft className="size-4" aria-hidden />
            </Link>
            {month < current ? (
              <Link to={`/month/${addMonths(month, 1)}`} aria-label="Next month" className={`${arrow} hover:bg-muted`}>
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            ) : null}
          </nav>
        )}
      </div>

      {!valid ? (
        <p role="alert" className="text-sm text-muted-foreground">
          “{month}” isn’t a month. <Link to="/month" className="underline underline-offset-2">Go to the current month</Link>.
        </p>
      ) : query.isPending ? (
        <div data-testid="month-skeleton" className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
          </div>
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : query.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
          <p>Couldn’t load this month. {query.error.message}</p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : d!.transaction_count === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No transactions in {monthLabel(month, 'long')} yet.</p>
      ) : (
        <>
          <MonthTiles d={d!} />
          <EssentialityBar d={d!} />
          {d!.income_transactions.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Income</CardTitle></CardHeader>
              <CardContent><TransactionList rows={d!.income_transactions} /></CardContent>
            </Card>
          )}
          <Card>
            <CardHeader><CardTitle>Spending by category</CardTitle></CardHeader>
            <CardContent><CategoryTable d={d!} /></CardContent>
          </Card>
          {d!.largest.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Largest transactions</CardTitle></CardHeader>
              <CardContent><TransactionList rows={d!.largest} /></CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
