import { Link, useNavigate } from 'react-router'
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts'
import { BUCKETS, spendingLink, type Bucket } from '@/features/spending/data'
import { monthLabel } from '@/lib/dates'
import { chartAnimation, useAnimateOnce } from '@/lib/motion'
import { ChartCard } from './ChartCard'
import { ChartFrame } from './ChartFrame'
import { moneyCompact, moneyWhole } from './chartFormat'
import { ChartTooltip, LegendKey } from './ChartTooltip'
import { useMonthly } from './queries'

const tick = { fill: 'var(--viz-muted)', fontSize: 12 }
const series = BUCKETS.filter((b) => b.value !== 'unset').map((b) => ({ key: b.label, value: b.value, color: b.color }))

export function EssentialityCard() {
  const query = useMonthly()
  const navigate = useNavigate()
  // Animate the first render only: refetches and hovers redraw in place.
  const motion = chartAnimation(useAnimateOnce(query.isSuccess))
  return (
    <ChartCard
      title="Essential, flexible, discretionary"
      description="Last 6 months. Select a bar segment to see the categories behind it."
      query={query}
      isEmpty={(d) => d.every((m) => Number(m.expenses) === 0)}
      height={240}
    >
      {(data) => {
        const rows = data.slice(-6).map((m) => ({
          key: m.month,
          label: monthLabel(m.month),
          Essential: Number(m.essential),
          Flexible: Number(m.flexible),
          Discretionary: Number(m.discretionary),
        }))
        const latest = rows.at(-1)!.key
        return (
          <div>
            <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {series.map((s) => (
                <LegendKey key={s.key} color={s.color} label={s.key} />
              ))}
            </div>
            <div
              role="img"
              aria-label="Essential, flexible and discretionary spending for the last 6 months"
              className="[&_.recharts-bar-rectangle]:cursor-pointer"
            >
            <ChartFrame height={240}>
              <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
                <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={{ stroke: 'var(--viz-axis)' }} />
                <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={moneyCompact} width={48} />
                <Tooltip
                  cursor={{ fill: 'var(--viz-grid)', opacity: 0.5 }}
                  content={(p) => (
                    <ChartTooltip
                      active={p.active}
                      payload={[...(p.payload ?? [])].reverse() as never}
                      title={monthLabel(String(rows.find((r) => r.label === p.label)?.key ?? ''), 'long')}
                      format={moneyWhole}
                    />
                  )}
                />
                {series.map((s, i) => (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    stackId="spend"
                    fill={s.color}
                    stroke="var(--card)"
                    strokeWidth={2}
                    maxBarSize={24}
                    radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
                    {...motion}
                    onClick={(bar) => void navigate(spendingLink(s.value as Bucket, String((bar as { payload?: { key?: string } }).payload?.key ?? latest)))}
                  />
                ))}
              </BarChart>
            </ChartFrame>
            </div>
            <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>See {monthLabel(latest, 'long')}:</span>
              {BUCKETS.map((b, i) => (
                <span key={b.value}>
                  {i > 0 && <span aria-hidden className="mr-2">·</span>}
                  <Link to={spendingLink(b.value, latest)} className="underline underline-offset-2 hover:text-foreground">
                    {b.label}
                  </Link>
                </span>
              ))}
            </p>
          </div>
        )
      }}
    </ChartCard>
  )
}
