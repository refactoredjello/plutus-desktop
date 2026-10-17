import type { ReactNode } from 'react'

export interface TooltipRow {
  name?: string | number
  value?: string | number | readonly (string | number)[]
  color?: string
  dashed?: boolean
}

/** Recharts passes these props to the element given as `content`. Values lead, names follow. */
export function ChartTooltip({
  active,
  payload,
  title,
  format,
}: {
  active?: boolean
  payload?: readonly TooltipRow[]
  title: ReactNode
  format: (value: number) => string
}) {
  const rows = (payload ?? []).filter((r) => r.value !== undefined && r.value !== null)
  if (!active || rows.length === 0) return null
  return (
    <div className="rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <div className="mb-1 text-muted-foreground">{title}</div>
      {rows.map((r) => (
        <div key={String(r.name)} className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-0.5 w-3 rounded"
            style={{ background: r.color, opacity: r.dashed ? 0.6 : 1 }}
          />
          <span className="font-medium tabular-nums">{format(Number(r.value))}</span>
          <span className="text-muted-foreground">{r.name}</span>
        </div>
      ))}
    </div>
  )
}

export function LegendKey({ color, label, shape = 'box' }: { color: string; label: string; shape?: 'box' | 'line' | 'dashed' }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {shape === 'box' ? (
        <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: color }} />
      ) : (
        <span
          aria-hidden
          className="inline-block w-4 border-t-2"
          style={{ borderColor: color, borderTopStyle: shape === 'dashed' ? 'dashed' : 'solid' }}
        />
      )}
      {label}
    </span>
  )
}
