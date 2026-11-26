import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type { Schemas } from '@/api/client'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Delta } from '@/features/month/Delta'
import { formatMoney } from '@/lib/money'
import { useMonthly, useProjection } from './queries'

function Tile({
  label,
  query,
  render,
  to,
}: {
  label: string
  /** Makes the whole tile a link. */
  to?: string
  query: UseQueryResult<unknown>
  render: () => { value: string; hint: string; delta?: ReactNode } | null
}) {
  let body: ReactNode
  if (query.isPending) {
    body = <Skeleton data-testid="tile-skeleton" className="mt-1 h-8 w-32" />
  } else if (query.isError) {
    body = <p role="alert" className="mt-1 text-sm text-muted-foreground">Couldn’t load.</p>
  } else {
    const r = render()
    // Replaces the skeleton when the data arrives, so it settles in once per load, not on refetch.
    body = r ? (
      <div className="motion-fade-up">
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <p className="text-2xl font-semibold tracking-tight">{r.value}</p>
          {r.delta}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{r.hint}</p>
      </div>
    ) : (
      <p className="mt-1 text-sm text-muted-foreground">No data yet.</p>
    )
  }
  const card = (
    <Card size="sm" className={to ? 'transition-colors hover:bg-muted/50' : undefined}>
      <CardContent>
        <p className="text-sm text-muted-foreground">{label}</p>
        {body}
      </CardContent>
    </Card>
  )
  return to ? (
    <Link to={to} className="block rounded-xl focus-visible:outline-2 focus-visible:outline-ring">
      {card}
    </Link>
  ) : (
    card
  )
}

/**
 * The income and spending tiles show the difference from last month. This month is still in
 * progress, so it is never judged against a whole month: the difference stays uncoloured.
 */
export function StatRow() {
  const monthly = useMonthly()
  const projection = useProjection()
  const current = (): Schemas['MonthlySummary'] | null => monthly.data?.at(-1) ?? null
  const previous = monthly.data?.at(-2)

  return (
    <section aria-label="This month" className="grid gap-4 sm:grid-cols-3">
      <Tile
        label="Income so far"
        to="/month"
        query={monthly}
        render={() => {
          const c = current()
          return c && {
            value: formatMoney(c.income),
            hint: previous ? `Last month: ${formatMoney(previous.income)}` : '',
            delta: previous && <Delta value={Number(c.income)} base={Number(previous.income)} better="higher" judge={false} />,
          }
        }}
      />
      <Tile
        label="Spent so far"
        to="/month"
        query={monthly}
        render={() => {
          const c = current()
          return c && {
            value: formatMoney(c.expenses),
            hint: previous ? `Last month: ${formatMoney(previous.expenses)}` : '',
            delta: previous && <Delta value={Number(c.expenses)} base={Number(previous.expenses)} better="lower" judge={false} />,
          }
        }}
      />
      <Tile
        label="Projected month-end balance"
        query={projection}
        render={() => {
          const m = projection.data?.months[0]
          return m ? { value: formatMoney(m.projected_end_balance), hint: `Balance today: ${formatMoney(projection.data!.current_balance)}` } : null
        }}
      />
    </section>
  )
}
