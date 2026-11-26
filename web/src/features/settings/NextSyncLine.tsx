import { formatDateTime, formatRelative } from '@/lib/format'
import { useSyncSchedule } from '@/features/sync/queries'
import { useSimplefinStatus } from './queries'

export function NextSyncLine() {
  const schedule = useSyncSchedule()
  const simplefin = useSimplefinStatus()
  if (!schedule.data || !simplefin.data) return null
  const { enabled, interval_hours, next_run_at } = schedule.data

  let text: string
  if (!enabled) text = 'Scheduled syncs are off.'
  else if (!simplefin.data.connected) text = 'Scheduled syncs start after you connect a bank.'
  else if (!next_run_at) text = 'No scheduled sync is pending.'
  else
    text = `Next scheduled sync: ${formatDateTime(next_run_at)} (${formatRelative(next_run_at)}), every ${interval_hours} hours.`

  return <p className="text-xs text-muted-foreground tabular-nums">{text}</p>
}
