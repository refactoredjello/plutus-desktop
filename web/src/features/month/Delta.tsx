import { ArrowDown, ArrowUp } from 'lucide-react'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { compare } from './data'

export const DANGER = 'text-destructive'
export const SUCCESS = 'text-emerald-700 dark:text-emerald-400'

/**
 * A value against its comparison (last month, or the average): an arrow and the size of the
 * difference, a percentage of the comparison ("points" for a ratio such as the savings rate).
 * Coloured like CategoryTable: good or bad for this metric (`better`), neutral within the 5% band
 * or when `judge` is off (a month still in progress). Nothing without a comparison.
 */
export function Delta({
  value,
  base,
  better,
  unit = 'percent',
  judge = true,
}: {
  value: number | null
  base: number | null
  better: 'higher' | 'lower'
  unit?: 'percent' | 'points'
  judge?: boolean
}) {
  if (value === null || base === null) return null
  const { tone, delta } = compare(value, base)
  if (delta === 0) return null
  let size: string
  if (unit === 'points') size = `${(Math.abs(delta) * 100).toFixed(1)} pts`
  else if (base === 0) size = formatMoney(String(Math.abs(delta)))
  else size = `${Math.round((Math.abs(delta) / Math.abs(base)) * 100)}%`
  const up = delta > 0
  const good = up === (better === 'higher')
  const Arrow = up ? ArrowUp : ArrowDown
  return (
    <span
      data-testid="delta"
      className={cn(
        'inline-flex items-center gap-0.5 text-xs font-medium tabular-nums',
        judge && (tone === 'up' || tone === 'down') ? (good ? SUCCESS : DANGER) : 'text-muted-foreground',
      )}
    >
      <Arrow aria-hidden className="size-3" />
      <span className="sr-only">{up ? 'up' : 'down'}</span>
      {size}
    </span>
  )
}
