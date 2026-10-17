import { PageHeader } from '@/app/PageHeader'
import { BalanceCard } from '@/features/overview/BalanceCard'
import { ChangesCard } from '@/features/overview/ChangesCard'
import { CashflowCard } from '@/features/overview/CashflowCard'
import { CategoryCard } from '@/features/overview/CategoryCard'
import { EssentialityCard } from '@/features/overview/EssentialityCard'
import { StatRow } from '@/features/overview/StatRow'
import '@/features/overview/chart.css'

export function OverviewPage() {
  return (
    <>
      <PageHeader title="Overview" description="Your month at a glance." />
      <div className="space-y-6">
        <ChangesCard />
        <StatRow />
        <CashflowCard />
        <div className="grid gap-6 lg:grid-cols-2">
          <CategoryCard />
          <EssentialityCard />
        </div>
        <BalanceCard />
      </div>
    </>
  )
}
