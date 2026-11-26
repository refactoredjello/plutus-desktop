import { Button } from '@/components/ui/button'
import { useSimplefinStatus } from '@/features/settings/queries'
import { useSync } from '@/features/sync/queries'
import { DAILY_REQUEST_BUDGET, requestsInLastDay } from '@/features/sync/requests'

/** Pull from the bank, then recalculate; disabled when the server would refuse the run. */
export function SyncButton() {
  const sync = useSync()
  const simplefin = useSimplefinStatus()
  const used = sync.runs ? requestsInLastDay(sync.runs) : 0

  let hint = 'Pull new transactions from your bank, then re-apply your rules. Contacts your bank (SimpleFIN).'
  let blocked = !simplefin.data || !sync.runs
  if (simplefin.data && !simplefin.data.connected) {
    hint = 'Connect a bank in Settings'
    blocked = true
  } else if (used >= DAILY_REQUEST_BUDGET) {
    hint = `Daily SimpleFIN limit reached: ${used} of ${DAILY_REQUEST_BUDGET} requests in the last 24 hours`
    blocked = true
  }

  return (
    // A disabled button gets no pointer events, so the wrapper carries the tooltip too.
    <span title={hint} className="shrink-0">
      <Button variant="outline" size="sm" title={hint} onClick={sync.start} disabled={blocked || sync.isRunning}>
        {sync.isRunning ? 'Syncing...' : 'Sync'}
      </Button>
    </span>
  )
}
