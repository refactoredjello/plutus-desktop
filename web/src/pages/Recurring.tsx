import { PageHeader } from '@/app/PageHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { annualSummary, useRecurring } from '@/features/recurring/queries'
import { ConfirmedTable, ProposedList } from '@/features/recurring/RecurringTables'
import { formatMoney } from '@/lib/money'

export function RecurringPage() {
  const recurring = useRecurring()
  const charges = recurring.data ?? []
  const proposed = charges.filter((c) => c.status === 'proposed')
  const confirmed = charges.filter((c) => c.status === 'confirmed')
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
              Your recurring bills cost{' '}
              <span className="font-medium tabular-nums text-foreground">{formatMoney(summary.total)}</span> a year;{' '}
              <span className="font-medium tabular-nums text-foreground">{formatMoney(summary.flexible)}</span> of that is
              flexible or discretionary.
            </p>
          )}
          {proposed.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium">Needs review</h2>
              <ProposedList charges={proposed} />
            </section>
          )}
          <section className="space-y-2">
            <h2 className="text-sm font-medium">Confirmed</h2>
            {confirmed.length ? (
              <ConfirmedTable charges={confirmed} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing confirmed yet. Confirm detected charges to track what they cost each year.
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
