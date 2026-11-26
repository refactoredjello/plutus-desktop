import { PageHeader } from '@/app/PageHeader'
import { AccountsCard } from '@/features/settings/AccountsCard'
import { AppearanceCard } from '@/features/settings/AppearanceCard'
import { BankConnectionCard } from '@/features/settings/BankConnectionCard'
import { ClearDismissalsCard } from '@/features/settings/ClearDismissalsCard'
import { CategoriesCard } from '@/features/settings/CategoriesCard'
import { ConfigCard } from '@/features/settings/ConfigCard'
import { LlmStatusLine } from '@/features/settings/LlmStatusLine'
import { NextSyncLine } from '@/features/settings/NextSyncLine'
import { RequestsUsedLine } from '@/features/settings/RequestsUsedLine'
import { RulesCard } from '@/features/settings/RulesCard'
import { SyncHistoryCard } from '@/features/settings/SyncHistoryCard'
import { VersionLine } from '@/features/settings/VersionLine'

export function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Bank connection, sync history, and categories."
      />
      <BankConnectionCard />
      <SyncHistoryCard />
      <div className="space-y-1">
        <NextSyncLine />
        <RequestsUsedLine />
      </div>
      <AccountsCard />
      <LlmStatusLine />
      <ConfigCard />
      <CategoriesCard />
      <RulesCard />
      <ClearDismissalsCard />
      <AppearanceCard />
      <VersionLine />
    </div>
  )
}
