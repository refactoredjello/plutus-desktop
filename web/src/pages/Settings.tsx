import { PageHeader } from '@/app/PageHeader'
import { AccountsCard } from '@/features/settings/AccountsCard'
import { BankConnectionCard } from '@/features/settings/BankConnectionCard'
import { ClearDismissalsCard } from '@/features/settings/ClearDismissalsCard'
import { CategoriesCard } from '@/features/settings/CategoriesCard'
import { ConfigCard } from '@/features/settings/ConfigCard'
import { LlmStatusLine } from '@/features/settings/LlmStatusLine'
import { useSimplefinStatus, useSync } from '@/features/settings/queries'
import { NextSyncLine } from '@/features/settings/NextSyncLine'
import { RequestsUsedLine } from '@/features/settings/RequestsUsedLine'
import { RulesCard } from '@/features/settings/RulesCard'
import { SyncHistoryCard } from '@/features/settings/SyncHistoryCard'
import { SyncNowButton } from '@/features/settings/SyncNowButton'
import { VersionLine } from '@/features/settings/VersionLine'

export function SettingsPage() {
  const status = useSimplefinStatus()
  const sync = useSync()
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Bank connection, sync history, and categories."
        action={
          <SyncNowButton
            onSync={() => sync.start()}
            running={sync.isRunning}
            connected={status.data?.connected ?? false}
          />
        }
      />
      {sync.error && (
        <p role="alert" className="-mt-3 text-sm text-destructive">
          {sync.error}
        </p>
      )}
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
      <VersionLine />
    </div>
  )
}
