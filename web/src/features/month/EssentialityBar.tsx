import { Link } from 'react-router'
import { BUCKETS, spendingLink } from '@/features/spending/data'
import { formatMoney } from '@/lib/money'
import type { Detail } from './data'

export function EssentialityBar({ d }: { d: Detail }) {
  const rows = BUCKETS.map((b) => ({ ...b, share: d.essentiality.find((e) => e.essentiality === b.value) }))
  const bar = rows.filter((r) => r.share && Number(r.share.total) > 0)
  const sum = bar.reduce((s, r) => s + Number(r.share!.total), 0)
  return (
    <section aria-label="Essentiality" className="viz">
      {sum > 0 && (
        <div role="img" aria-label="Spending split by essentiality" className="flex h-2.5 gap-0.5 overflow-hidden rounded-full">
          {bar.map((r) => (
            <span key={r.value} className="block h-full min-w-0.5" style={{ flexGrow: Number(r.share!.total) / sum, background: r.color }} />
          ))}
        </div>
      )}
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {rows.map((r) =>
          r.share ? (
            <li key={r.value}>
              <Link
                to={spendingLink(r.value, d.month)}
                className="inline-flex items-center gap-1.5 rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: r.color }} />
                <span>{r.label}</span>
                <span className="tabular-nums">{formatMoney(r.share.total)}</span>
                <span className="text-muted-foreground tabular-nums">· {Math.round(r.share.share * 100)}%</span>
              </Link>
            </li>
          ) : null,
        )}
      </ul>
    </section>
  )
}
