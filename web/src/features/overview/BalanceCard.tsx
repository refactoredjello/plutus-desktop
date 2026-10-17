import { CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from 'recharts'
import { formatDate } from '@/lib/format'
import { ChartCard } from './ChartCard'
import { ChartFrame } from './ChartFrame'
import { moneyCompact, moneyWhole } from './chartFormat'
import { ChartTooltip, LegendKey } from './ChartTooltip'
import { balanceSeries } from './data'
import { useBalances, useProjection } from './queries'

const tick = { fill: 'var(--viz-muted)', fontSize: 12 }
const shortDate = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export function BalanceCard() {
  const balances = useBalances(90)
  const projection = useProjection()
  const projectionOk = projection.isSuccess && projection.data.months.length > 0

  return (
    <ChartCard
      id="balance"
      title="Balance and projection"
      description="Total across all accounts: the last 90 days, then projected month-ends."
      query={balances}
      isEmpty={(d) => d.every((s) => s.points.length === 0)}
      height={280}
    >
      {(data) => {
        const rows = balanceSeries(data, projectionOk ? projection.data : undefined)
        const hasProjection = rows.some((r) => r.projected !== undefined && r.actual === undefined)
        return (
          <div>
            <div role="img" aria-label="Total balance over the last 90 days with projected month-end balances">
              <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <LegendKey color="var(--viz-line)" label="Balance" shape="line" />
                {hasProjection && <LegendKey color="var(--viz-line)" label="Projected month-end" shape="dashed" />}
              </div>
              <ChartFrame height={280}>
                <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
                  <XAxis
                    dataKey="t"
                    type="number"
                    scale="time"
                    domain={['dataMin', 'dataMax']}
                    tick={tick}
                    tickLine={false}
                    axisLine={{ stroke: 'var(--viz-axis)' }}
                    tickFormatter={shortDate}
                    tickCount={6}
                  />
                  <YAxis
                    tick={tick}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={moneyCompact}
                    width={52}
                    domain={[(min: number) => Math.floor(min / 1000) * 1000, (max: number) => Math.ceil(max / 1000) * 1000]}
                  />
                  <Tooltip
                    cursor={{ stroke: 'var(--viz-axis)' }}
                    content={(p) => {
                      const row = rows.find((r) => r.t === p.label)
                      const isProjected = row?.actual === undefined
                      const payload = (p.payload ?? []).filter((x) => (isProjected ? x.dataKey === 'projected' : x.dataKey === 'actual'))
                      return (
                        <ChartTooltip
                          active={p.active}
                          payload={payload.map((x) => ({ ...x, name: isProjected ? 'Projected month-end' : 'Balance', dashed: isProjected })) as never}
                          title={row ? formatDate(row.date) : ''}
                          format={moneyWhole}
                        />
                      )
                    }}
                  />
                  <Line dataKey="actual" name="Balance" stroke="var(--viz-line)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" dot={false} activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }} isAnimationActive={false} />
                  <Line
                    dataKey="projected"
                    name="Projected month-end"
                    stroke="var(--viz-line)"
                    strokeWidth={2}
                    strokeDasharray="6 5"
                    strokeLinecap="round"
                    dot={{ r: 4, fill: 'var(--card)', stroke: 'var(--viz-line)', strokeWidth: 2 }}
                    activeDot={{ r: 5, stroke: 'var(--card)', strokeWidth: 2 }}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ChartFrame>
            </div>
            {projection.isError ? (
              <p className="mt-3 text-xs text-muted-foreground">Projection unavailable right now.</p>
            ) : (
              projection.isSuccess && (
                <ul className="mt-3 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                  {projection.data.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              )
            )}
          </div>
        )
      }}
    </ChartCard>
  )
}
