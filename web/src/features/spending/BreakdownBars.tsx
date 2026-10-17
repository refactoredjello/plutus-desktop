import { Link } from 'react-router'
import type { Schemas } from '@/api/client'
import { formatMoney } from '@/lib/money'
import { BUCKETS, breakdown, rowLink, type Bucket } from './data'

const percent = (share: number) => `${Math.round(share * 100)}%`

/** Horizontal bars, one link per category. Same look as Overview's category card, tinted with the bucket colour. */
export function BreakdownBars({
  rows: data,
  bucket,
  month,
}: {
  rows: Schemas['CategoryTotal'][]
  bucket: Bucket
  month: string
}) {
  const { rows } = breakdown(data)
  const max = Math.max(...rows.map((r) => r.total), 1)
  const color = BUCKETS.find((b) => b.value === bucket)!.color
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.id ?? 'uncategorized'}>
          <Link
            to={rowLink(r.id, bucket, month)}
            className="-mx-2 block rounded-md px-2 py-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate">{r.label}</span>
              <span className="whitespace-nowrap">
                <span className="font-medium tabular-nums">{formatMoney(String(r.total))}</span>
                <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                  {percent(r.share)} · {r.count} {r.count === 1 ? 'transaction' : 'transactions'}
                </span>
              </span>
            </span>
            <span className="mt-1 block h-2 rounded-full bg-muted">
              <span
                className="block h-2 rounded-r-[4px] rounded-l-full"
                style={{ width: `${(r.total / max) * 100}%`, background: color }}
              />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
