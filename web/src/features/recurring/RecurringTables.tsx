import type { Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EssentialitySelect } from '@/features/transactions/selects'
import { formatDate, humanizeEnum } from '@/lib/format'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { useUpdateRecurring } from './queries'

type Charge = Schemas['RecurringChargeRead']

const income = 'text-emerald-700 dark:text-emerald-400'
const signed = (value: string) => `${Number(value) > 0 ? '+' : ''}${formatMoney(value)}`

/** Detected charges awaiting a decision: quiet list with Confirm / Dismiss. */
export function ProposedList({ charges }: { charges: Charge[] }) {
  const update = useUpdateRecurring()
  return (
    <ul className="divide-y rounded-lg border">
      {charges.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{c.merchant_key}</p>
            <p className="text-xs text-muted-foreground">
              {humanizeEnum(c.cadence)} · next {formatDate(c.next_expected_date)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className={cn('text-sm tabular-nums', Number(c.amount) > 0 && income)}>{signed(c.amount)}</span>
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Confirm ${c.merchant_key}`}
              onClick={() => update.mutate({ id: c.id, body: { status: 'confirmed' } })}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Dismiss ${c.merchant_key}`}
              onClick={() => update.mutate({ id: c.id, body: { status: 'dismissed' } })}
            >
              Dismiss
            </Button>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function ConfirmedTable({ charges }: { charges: Charge[] }) {
  const update = useUpdateRecurring()
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Merchant</TableHead>
          <TableHead>Cadence</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Next expected</TableHead>
          <TableHead>Essentiality</TableHead>
          <TableHead className="text-right">Annual cost</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {charges.map((c) => {
          const inflow = Number(c.amount) > 0
          return (
            <TableRow key={c.id}>
              <TableCell className="max-w-56 truncate font-medium" title={c.merchant_key}>
                {c.merchant_key}
              </TableCell>
              <TableCell className="text-muted-foreground">{humanizeEnum(c.cadence)}</TableCell>
              <TableCell className={cn('whitespace-nowrap text-right tabular-nums', inflow && income)}>
                {signed(c.amount)}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(c.next_expected_date)}</TableCell>
              <TableCell>
                {inflow ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <EssentialitySelect
                    inline
                    value={c.essentiality}
                    onChange={(essentiality) => essentiality && update.mutate({ id: c.id, body: { essentiality } })}
                    label={`Essentiality for ${c.merchant_key}`}
                  />
                )}
              </TableCell>
              <TableCell className={cn('whitespace-nowrap text-right tabular-nums', inflow && income)}>
                {signed(c.annual_cost)}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  aria-label={`Stop tracking ${c.merchant_key}`}
                  onClick={() => update.mutate({ id: c.id, body: { status: 'dismissed' } })}
                >
                  Stop tracking
                </Button>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
