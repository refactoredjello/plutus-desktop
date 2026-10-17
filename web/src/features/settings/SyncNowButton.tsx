import { Button } from '@/components/ui/button'

export function SyncNowButton({
  onSync,
  running,
  connected,
}: {
  onSync: () => void
  running: boolean
  connected: boolean
}) {
  return (
    <Button onClick={onSync} disabled={running || !connected} title={connected ? undefined : 'Connect a bank first'}>
      {running ? 'Syncing…' : 'Sync now'}
    </Button>
  )
}
