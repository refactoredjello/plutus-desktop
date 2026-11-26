import { PageHeader } from '@/app/PageHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { annualSummary, useRecurring } from '@/features/recurring/queries'
import { ConfirmedTable, ProposedList } from '@/features/recurring/RecurringTables'
import { formatMoney } from '@/lib/money'

const figure = (value: string) => <span className="font-medium tabular-nums text-foreground">{formatMoney(value)}</span>

export function RecurringPage() {
  const recurring = useRecurring()
  const charges = recurring.data ?? []
  const proposed = charges.filter((c) => c.status === 'proposed')
  const confirmed = charges.filter((c) => c.status === 'confirmed')
  const income = confirmed.filter((c) => Number(c.amount) > 0)
  const bills = confirmed.filter((c) => Number(c.amount) < 0)
  const summary = annualSummary(charges)

  return (
    <div>
      <PageHeader title="Recurring" description="Subscriptions and bills detected from your history." />
      {recurring.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : recurring.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {recurring.error.message}
        </p>
      ) : (
        <div className="space-y-8">
          {confirmed.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {income.length > 0 && <>Your recurring income is {figure(summary.income)} a year. </>}
              {bills.length > 0 && (
                <>
                  Your recurring bills cost {figure(summary.total)} a year; {figure(summary.flexible)} of that is
                  flexible or discretionary.
                </>
              )}
            </p>
          )}
          {proposed.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium">Needs review</h2>
              <ProposedList charges={proposed} />
            </section>
          )}
          {income.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium">Income</h2>
              <ConfirmedTable charges={income} kind="income" />
            </section>
          )}
          {bills.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium">Bills</h2>
              <ConfirmedTable charges={bills} kind="bills" />
            </section>
          )}
          {confirmed.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing confirmed yet. Confirm detected charges to track what they cost each year.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
