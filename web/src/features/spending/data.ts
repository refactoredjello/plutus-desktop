import type { Schemas } from '@/api/client'
import { monthEnd, monthKey } from '@/lib/dates'

export type Bucket = Schemas['EssentialityFilter']

export const BUCKETS: { value: Bucket; label: string; color: string }[] = [
  { value: 'essential', label: 'Essential', color: 'var(--viz-essential)' },
  { value: 'flexible', label: 'Flexible', color: 'var(--viz-flexible)' },
  { value: 'discretionary', label: 'Discretionary', color: 'var(--viz-discretionary)' },
  { value: 'unset', label: 'Not set', color: 'var(--viz-other)' },
]

export const isBucket = (v: string | null): v is Bucket => BUCKETS.some((b) => b.value === v)
export const isMonth = (v: string | null): v is string => v !== null && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)

export const bucketLabel = (b: Bucket) => BUCKETS.find((x) => x.value === b)!.label

/** Overview's link into the breakdown. */
export function spendingLink(essentiality: Bucket, month: string): string {
  return `/spending?${new URLSearchParams({ essentiality, month })}`
}

/** Transactions behind one row of the breakdown. Uncategorized spending has no category id to filter by. */
export function rowLink(categoryId: number | null, bucket: Bucket, month: string): string {
  const range = { start: `${month}-01`, end: monthEnd(month) }
  const p =
    categoryId === null
      ? new URLSearchParams({ uncategorized: '1', ...range })
      : new URLSearchParams({ category: String(categoryId), essentiality: bucket, ...range })
  return `/transactions?${p}`
}

export interface BreakdownRow {
  id: number | null
  label: string
  total: number
  count: number
  share: number
}

export function breakdown(rows: Schemas['CategoryTotal'][]): { total: number; rows: BreakdownRow[] } {
  const total = rows.reduce((s, r) => s + Number(r.total), 0)
  return {
    total,
    rows: rows
      .map((r) => ({ id: r.category_id, label: r.label, total: Number(r.total), count: r.count, share: total ? Number(r.total) / total : 0 }))
      .sort((a, b) => b.total - a.total),
  }
}

export const currentMonth = () => monthKey(new Date())
