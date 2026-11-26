import { useEffect, useState } from 'react'
import { useSyncRuns } from '@/features/sync/queries'
import { formatDateTime, formatRelative } from '@/lib/format'

/** "Synced 2 hours ago" from the newest successful run, kept current every minute. */
export function LastSynced() {
  const runs = useSyncRuns()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  if (!runs.data) return null
  const last = runs.data.find((r) => r.status === 'success')
  const at = last && (last.finished_at ?? last.started_at)
  return (
    <span className="hidden shrink-0 text-xs text-muted-foreground lg:inline" title={at ? formatDateTime(at) : undefined}>
      {at ? `Synced ${formatRelative(at, now)}` : 'Never synced'}
    </span>
  )
}
