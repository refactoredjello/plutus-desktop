import type { Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EssentialitySelect } from '@/features/transactions/selects'
import { daysFromToday } from '@/lib/dates'
import { formatDate, humanizeEnum } from '@/lib/format'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { useUpdateRecurring } from './queries'

type Charge = Schemas['RecurringChargeRead']

const income = 'text-emerald-700 dark:text-emerald-400'
const overdueTone = 'text-amber-700 dark:text-amber-400'

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`

/** "in 5 days", "today", "3 days overdue" for the next expected date. */
function NextHint({ date }: { date: string }) {
  const n = daysFromToday(date)
  const text = n === 0 ? 'today' : n === 1 ? 'tomorrow' : n > 0 ? `in ${days(n)}` : `${days(-n)} overdue`
  return <span className={cn('text-xs', n < 0 ? overdueTone : 'text-muted-foreground')}>{text}</span>
}

/** The friendly name, with the merchant key under it when they differ. */
function Name({ charge }: { charge: Charge }) {
  return (
    <>
      <span className="block truncate font-medium" title={charge.merchant_key}>
        {charge.name}
      </span>
      {charge.name !== charge.merchant_key && (
        <span className="block truncate text-xs font-normal text-muted-foreground">{charge.merchant_key}</span>
      )}
    </>
  )
}
const signed = (value: string) => `${Number(value) > 0 ? '+' : ''}${formatMoney(value)}`

/** Detected charges awaiting a decision: quiet list with Confirm / Dismiss. */
export function ProposedList({ charges }: { charges: Charge[] }) {
  const update = useUpdateRecurring()
  return (
    <ul className="divide-y rounded-lg border">
      {charges.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2">
          <div className="min-w-0">
            <div className="text-sm">
              <Name charge={c} />
            </div>
            <p className="text-xs text-muted-foreground">
              {humanizeEnum(c.cadence)} · next {formatDate(c.next_expected_date)} <NextHint date={c.next_expected_date} />
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className={cn('text-sm tabular-nums', Number(c.amount) > 0 && income)}>{signed(c.amount)}</span>
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Confirm ${c.name}`}
              onClick={() => update.mutate({ id: c.id, body: { status: 'confirmed' } })}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Dismiss ${c.name}`}
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
              <TableCell className="max-w-56">
                <Name charge={c} />
              </TableCell>
              <TableCell className="text-muted-foreground">{humanizeEnum(c.cadence)}</TableCell>
              <TableCell className={cn('whitespace-nowrap text-right tabular-nums', inflow && income)}>
                {signed(c.amount)}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <span className="text-muted-foreground">{formatDate(c.next_expected_date)}</span>{' '}
                <NextHint date={c.next_expected_date} />
              </TableCell>
              <TableCell>
                {inflow ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <EssentialitySelect
                    inline
                    value={c.essentiality}
                    onChange={(essentiality) => essentiality && update.mutate({ id: c.id, body: { essentiality } })}
                    label={`Essentiality for ${c.name}`}
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
                  aria-label={`Stop tracking ${c.name}`}
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
