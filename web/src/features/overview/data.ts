import type { Schemas } from '@/api/client'
import { isoDate, monthEnd, parseDate } from '@/lib/dates'

export interface CategoryRow {
  key: string
  label: string
  total: number
  /** Transactions page link; null for the folded remainder, which spans many categories. */
  href: string | null
  /** Drawn in the neutral colour: Uncategorized and the folded remainder. */
  muted: boolean
}

/**
 * Largest `limit` categories, with the rest folded into one "N more categories" row.
 * The fold is deliberately not called "Other": Plaid has a real category with that label.
 */
export function topCategories(rows: Schemas['CategoryTotal'][], month: string, limit = 8): CategoryRow[] {
  const sorted = [...rows].sort((a, b) => Number(b.total) - Number(a.total))
  const top: CategoryRow[] = sorted.slice(0, limit).map((r) => ({
    key: r.category_id === null ? 'uncategorized' : String(r.category_id),
    label: r.label,
    total: Number(r.total),
    href: r.category_id === null ? uncategorizedLink(month) : categoryLink(r.category_id, month),
    muted: r.category_id === null,
  }))
  const rest = sorted.slice(limit)
  if (rest.length > 0) {
    top.push({
      key: 'rest',
      label: rest.length === 1 ? '1 more category' : `${rest.length} more categories`,
      total: rest.reduce((s, r) => s + Number(r.total), 0),
      href: null,
      muted: true,
    })
  }
  return top
}

/** Transactions page URL for spending with no category in one month. */
export function uncategorizedLink(month: string): string {
  const p = new URLSearchParams({ uncategorized: '1', start: `${month}-01`, end: monthEnd(month) })
  return `/transactions?${p}`
}

/** Transactions page URL for one category in one month, using the params that page reads. */
export function categoryLink(id: number, month: string): string {
  const p = new URLSearchParams({ category: String(id), start: `${month}-01`, end: monthEnd(month) })
  return `/transactions?${p}`
}

export interface BalancePoint {
  t: number
  date: string
  actual?: number
  projected?: number
}

/** Sum every account per day, carrying each account's last known balance forward over gaps. */
export function totalBalance(series: Schemas['AccountBalanceSeries'][]): { date: string; value: number }[] {
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.on)))].sort()
  const maps = series.map((s) => new Map(s.points.map((p) => [p.on, Number(p.balance)])))
  const last = maps.map(() => 0)
  return dates.map((date) => {
    maps.forEach((m, i) => {
      if (m.has(date)) last[i] = m.get(date)!
    })
    return { date, value: last.reduce((a, b) => a + b, 0) }
  })
}

/** Solid history plus dashed projected month-end points, joined at the last actual day. */
export function balanceSeries(
  series: Schemas['AccountBalanceSeries'][],
  projection?: Schemas['ProjectionRead'],
): BalancePoint[] {
  const total = totalBalance(series)
  const rows: BalancePoint[] = total.map((p) => ({ t: parseDate(p.date).getTime(), date: p.date, actual: p.value }))
  const anchor = rows.at(-1)
  if (!anchor || !projection) return rows
  anchor.projected = anchor.actual
  for (const m of projection.months) {
    const date = monthEnd(m.month)
    if (date <= anchor.date) continue
    rows.push({ t: parseDate(date).getTime(), date, projected: Number(m.projected_end_balance) })
  }
  return rows
}

export const todayIso = () => isoDate(new Date())

/** Drop leading months with no activity, so a short bank history doesn't show empty months. */
export function trimLeadingEmptyMonths<T extends { income: string; expenses: string }>(rows: T[]): T[] {
  const first = rows.findIndex((m) => Number(m.income) !== 0 || Number(m.expenses) !== 0)
  return first === -1 ? rows : rows.slice(first)
}
