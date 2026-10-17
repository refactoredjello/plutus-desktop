import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Schemas } from '@/api/client'
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format'
import { useSyncRuns } from './queries'

const statusVariant: Record<Schemas['SyncStatus'], 'secondary' | 'destructive' | 'outline'> = {
  success: 'secondary',
  error: 'destructive',
  running: 'outline',
}

export function SyncHistoryCard() {
  const runs = useSyncRuns()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sync history</CardTitle>
      </CardHeader>
      <CardContent>
        {runs.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : !runs.data?.length ? (
          <p className="text-sm text-muted-foreground">No syncs yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead className="text-right">Added</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <Badge variant={statusVariant[run.status]}>{run.status}</Badge>
                  </TableCell>
                  <TableCell title={formatDateTime(run.started_at)}>{formatRelative(run.started_at)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(run.started_at, run.finished_at)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{run.added}</TableCell>
                  <TableCell className="text-right tabular-nums">{run.updated}</TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground" title={run.error_text ?? undefined}>
                    {run.error_text}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
