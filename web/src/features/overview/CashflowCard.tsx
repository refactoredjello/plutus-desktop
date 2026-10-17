import { useNavigate } from 'react-router'
import { trimLeadingEmptyMonths } from './data'
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts'
import { monthLabel } from '@/lib/dates'
import { ChartCard } from './ChartCard'
import { ChartFrame } from './ChartFrame'
import { moneyCompact, moneyWhole } from './chartFormat'
import { ChartTooltip, LegendKey } from './ChartTooltip'
import { useMonthly } from './queries'

const tick = { fill: 'var(--viz-muted)', fontSize: 12 }

export function CashflowCard() {
  const query = useMonthly()
  const navigate = useNavigate()
  return (
    <ChartCard
      title="Income vs. expenses"
      description="Last 12 months. The line is net (income minus expenses). Select a bar to open that month."
      query={query}
      isEmpty={(d) => d.every((m) => Number(m.income) === 0 && Number(m.expenses) === 0)}
    >
      {(data) => {
        const rows = trimLeadingEmptyMonths(data).map((m) => ({
          key: m.month,
          label: monthLabel(m.month),
          Income: Number(m.income),
          Expenses: Number(m.expenses),
          Net: Number(m.net),
        }))
        const openMonth = (bar: unknown) => {
          const key = (bar as { payload?: { key?: string } }).payload?.key
          if (key) void navigate(`/month/${key}`)
        }
        return (
          <div role="img" aria-label="Monthly income, expenses and net for the last 12 months" className="[&_.recharts-bar-rectangle]:cursor-pointer">
            <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <LegendKey color="var(--viz-income)" label="Income" />
              <LegendKey color="var(--viz-expense)" label="Expenses" />
              <LegendKey color="var(--viz-ink)" label="Net" shape="line" />
            </div>
            <ChartFrame height={280}>
              <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
                <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
                <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={{ stroke: 'var(--viz-axis)' }} interval="preserveStartEnd" />
                <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={moneyCompact} width={48} />
                <ReferenceLine y={0} stroke="var(--viz-axis)" />
                <Tooltip
                  cursor={{ stroke: 'var(--viz-axis)' }}
                  content={(p) => (
                    <ChartTooltip
                      active={p.active}
                      payload={p.payload as never}
                      title={monthLabel(String(rows.find((r) => r.label === p.label)?.key ?? ''), 'long')}
                      format={moneyWhole}
                    />
                  )}
                />
                <Bar dataKey="Income" fill="var(--viz-income)" maxBarSize={14} radius={[4, 4, 0, 0]} isAnimationActive={false} onClick={openMonth} />
                <Bar dataKey="Expenses" fill="var(--viz-expense)" maxBarSize={14} radius={[4, 4, 0, 0]} isAnimationActive={false} onClick={openMonth} />
                <Line
                  dataKey="Net"
                  stroke="var(--viz-ink)"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  dot={{ r: 4, fill: 'var(--viz-ink)', stroke: 'var(--card)', strokeWidth: 2 }}
                  activeDot={{ r: 5, stroke: 'var(--card)', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ChartFrame>
          </div>
        )
      }}
    </ChartCard>
  )
}
