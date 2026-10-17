import { DAILY_REQUEST_BUDGET, requestsInLastDay } from './requests'
import { useSyncRuns } from './queries'

export function RequestsUsedLine() {
  const runs = useSyncRuns()
  if (!runs.data) return null
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      SimpleFIN requests in the last 24 hours: {requestsInLastDay(runs.data)} of {DAILY_REQUEST_BUDGET}
    </p>
  )
}
