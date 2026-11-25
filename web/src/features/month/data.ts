import type { Schemas } from '@/api/client'
import { formatMoney } from '@/lib/money'

/** Within this fraction of the average counts as "about the same as usual". */
export const SAME_BAND = 0.05

export type Detail = Schemas['MonthDetail']

export const monthName = (key: string) => {
  const [y, m] = key.split('-').map(Number)
  return new Date(y!, m! - 1, 1).toLocaleDateString('en-US', { month: 'long' })
}

export const percent = (ratio: number | null) => (ratio === null ? '—' : `${(ratio * 100).toFixed(1)}%`)

/** "3-mo avg" with a full window, "avg of 2 months" with less. */
export const avgPhrase = (n: number) => (n >= 3 ? `${n}-mo avg` : n === 1 ? 'avg of 1 month' : `avg of ${n} months`)

export type Tone = 'up' | 'down' | 'same' | 'none'

/** Compare a value with its average. Within the band (or without a usable average) is "same"/"none". */
export function compare(value: number, average: number | null): { tone: Tone; delta: number } {
  if (average === null) return { tone: 'none', delta: 0 }
  const delta = value - average
  if (Math.abs(delta) <= Math.abs(average) * SAME_BAND) return { tone: 'same', delta }
  return { tone: delta > 0 ? 'up' : 'down', delta }
}

export const signedMoney = (delta: number) =>
  `${delta > 0 ? '+' : '−'}${formatMoney(String(Math.abs(delta)))}`

export function categoryRowsSplit<T>(rows: T[], limit = 10): { shown: T[]; rest: T[] } {
  return { shown: rows.slice(0, limit), rest: rows.slice(limit) }
}

export const transactionLink = (t: Schemas['TransactionRead'], month: string, last: string) =>
  `/transactions?${new URLSearchParams({ q: t.payee ?? t.raw_description, start: `${month}-01`, end: last })}`
