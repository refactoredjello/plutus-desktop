import type { ReactNode } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { avgPhrase, compare, type Detail, percent } from './data'

const DANGER = 'text-destructive'
const SUCCESS = 'text-emerald-700 dark:text-emerald-400'

function Tile({ label, value, sub }: { label: string; value: string; sub: ReactNode }) {
  return (
    // Mounts with the month's data, so it settles in once per load, not on refetch.
    <Card size="sm" className="motion-fade-up">
      <CardContent>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
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
      />
      <Tile label={`Spending${so}`} value={formatMoney(d.expenses)} sub={spendingSub} />
      <Tile
        label={`Net${so}`}
        value={formatMoney(d.net)}
        sub={sameNote(d.net_average && formatMoney(d.net_average), d.net_average ? Number(d.net_average) : null, Number(d.net))}
      />
      <Tile
        label={`Savings rate${so}`}
        value={percent(d.savings_rate)}
        sub={avg(d.savings_rate_average === null ? null : percent(d.savings_rate_average))}
      />
    </section>
  )
}
