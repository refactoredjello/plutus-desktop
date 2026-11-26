import type { ReactNode } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { avgPhrase, compare, type Detail, percent } from './data'
import { DANGER, Delta, SUCCESS } from './Delta'

function Tile({ label, value, sub, delta, negative }: { label: string; value: string; sub: ReactNode; delta?: ReactNode; negative?: boolean }) {
  return (
    // Mounts with the month's data, so it settles in once per load, not on refetch.
    <Card size="sm" className="motion-fade-up">
      <CardContent>
        <p className="text-sm text-muted-foreground">{label}</p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <p className={cn('text-2xl font-semibold tracking-tight tabular-nums', negative && DANGER)}>{value}</p>
          {delta}
        </div>
        <p className="mt-1 min-h-4 text-xs text-muted-foreground tabular-nums">{sub}</p>
      </CardContent>
    </Card>
  )
}

export function MonthTiles({ d }: { d: Detail }) {
  const n = d.average_months
  const phrase = avgPhrase(n)
  const so = d.is_complete ? '' : ' so far'
  const avg = (text: string | null) => (n === 0 || text === null ? null : `${phrase} ${text}`)

  let spendingSub: ReactNode = avg(d.expenses_average === null ? null : formatMoney(d.expenses_average))
  if (d.is_complete && n > 0 && d.expenses_average !== null) {
    const { tone, delta } = compare(Number(d.expenses), Number(d.expenses_average))
    const money = formatMoney(String(Math.abs(delta)))
    if (tone === 'same') spendingSub = `About the same as usual (${spendingSub})`
    else if (tone === 'up' || tone === 'down')
      spendingSub = <span className={cn(tone === 'up' ? DANGER : SUCCESS)}>{money} {tone === 'up' ? 'above' : 'below'} {phrase}</span>
  }

  const num = (v: string | null) => (v === null ? null : Number(v))
  // An average only judges a finished month; one in progress shows the difference, uncoloured.
  const delta = (value: number | null, average: number | null, better: 'higher' | 'lower', unit?: 'points') =>
    n === 0 ? null : <Delta value={value} base={average} better={better} unit={unit} judge={d.is_complete} />

  const sameNote = (average: string | null, avgNum: number | null, cur: number) => {
    const text = avg(average)
    if (text && d.is_complete && avgNum !== null && compare(cur, avgNum).tone === 'same') return `About the same as usual (${text})`
    return text
  }

  return (
    <section aria-label="Month totals" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Tile
        label={`Income${so}`}
        value={formatMoney(d.income)}
        sub={sameNote(d.income_average && formatMoney(d.income_average), d.income_average ? Number(d.income_average) : null, Number(d.income))}
        delta={delta(Number(d.income), num(d.income_average), 'higher')}
      />
      <Tile
        label={`Spending${so}`}
        value={formatMoney(d.expenses)}
        sub={spendingSub}
        delta={delta(Number(d.expenses), num(d.expenses_average), 'lower')}
      />
      <Tile
        label={`Net${so}`}
        value={formatMoney(d.net)}
        negative={Number(d.net) < 0}
        sub={sameNote(d.net_average && formatMoney(d.net_average), d.net_average ? Number(d.net_average) : null, Number(d.net))}
        delta={delta(Number(d.net), num(d.net_average), 'higher')}
      />
      <Tile
        label={`Savings rate${so}`}
        value={percent(d.savings_rate)}
        negative={d.savings_rate !== null && d.savings_rate < 0}
        sub={avg(d.savings_rate_average === null ? null : percent(d.savings_rate_average))}
        delta={delta(d.savings_rate, d.savings_rate_average, 'higher', 'points')}
      />
    </section>
  )
}
