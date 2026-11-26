import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from '@/api/client'
import { notify, notifyError } from '@/lib/toast'

export const SYNC_POLL_MS = 2000
/** How often the header looks for a run that finished without it (a scheduled sync). */
export const SYNC_RUNS_REFRESH_MS = 60_000

type Run = Schemas['SyncRunRead']

// Shares the ['sync'] prefix, so finishing a sync refreshes it; the minute refetch keeps "in 3 hours" honest.
export const useSyncSchedule = () =>
  useQuery({
    queryKey: ['sync', 'schedule'],
    queryFn: () => unwrap(api.GET('/api/sync/schedule')),
    refetchInterval: 60_000,
  })

export const useSyncRuns = () =>
  useQuery({
    queryKey: ['sync', 'runs'],
    queryFn: () => unwrap(api.GET('/api/sync/runs', { params: { query: { limit: 20 } } })),
    refetchInterval: SYNC_RUNS_REFRESH_MS,
  })

const count = (n: number, one: string, many = one) => `${n} ${n === 1 ? one : many}`

/** What a recalculation changed, in a few words; empty when nothing. */
export function recalculateParts(r: Schemas['RecalculateRead']): string[] {
  return [
    r.recategorized > 0 && count(r.recategorized, 'recategorized'),
    r.categorized > 0 && count(r.categorized, 'newly categorized'),
    r.recurring_changes > 0 && count(r.recurring_changes, 'recurring change', 'recurring changes'),
  ].filter((p): p is string => typeof p === 'string')
}

/** "Synced: 12 new, 3 updated; 2 recategorized" or "Synced: nothing new". */
export function syncSummary(run: Run, recalc: Schemas['RecalculateRead']): string {
  const pulled = [run.added > 0 && `${run.added} new`, run.updated > 0 && `${run.updated} updated`].filter(Boolean)
  const changed = recalculateParts(recalc)
  return `Synced: ${pulled.length ? pulled.join(', ') : 'nothing new'}${changed.length ? `; ${changed.join(', ')}` : ''}`
}

const latestFinished = (runs: Run[]) =>
  runs.reduce((max, r) => (r.status !== 'running' && r.id > max ? r.id : max), 0)

/**
 * The header's bank sync. `start` begins a run; while one runs (ours or a scheduled one) it is
 * polled every 2s. When our run succeeds the rules are re-applied (POST /api/recalculate), every
 * query refetches, and one toast sums it up; a failed run toasts its error and skips that. A run
 * that finished without us (scheduled) refetches every query too.
 */
export function useSync() {
  const qc = useQueryClient()
  const runs = useSyncRuns()
  const [mine, setMine] = useState<number | null>(null)
  // The newest finished run already acted on; undefined until the runs first load.
  const handled = useRef<number | undefined>(undefined)

  const start = useMutation({
    mutationFn: () => unwrap(api.POST('/api/sync')),
    onSuccess: (run) => {
      setMine(run.id)
      return qc.invalidateQueries({ queryKey: ['sync', 'runs'] })
    },
    meta: { errorTitle: 'Sync failed' },
  })

  const recalculate = useMutation({
    mutationFn: () => unwrap(api.POST('/api/recalculate')),
    meta: { errorTitle: 'Recalculate failed' },
  })

  const runningId = runs.data?.find((r) => r.status === 'running')?.id
  const watchId = mine ?? runningId
  const polled = useQuery({
    queryKey: ['sync', 'run', watchId],
    queryFn: () => unwrap(api.GET('/api/sync/runs/{run_id}', { params: { path: { run_id: watchId! } } })),
    enabled: watchId !== undefined,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? SYNC_POLL_MS : false),
    gcTime: 0,
  })

  const { mutateAsync: recalc } = recalculate
  const run = polled.data
  useEffect(() => {
    if (!run || run.status === 'running' || run.id <= (handled.current ?? 0)) return
    handled.current = run.id
    if (run.id !== mine) {
      void qc.invalidateQueries()
      return
    }
    if (run.status === 'error') {
      notifyError('Sync failed', new Error(run.error_text ?? 'The sync did not finish'))
      void qc.invalidateQueries({ queryKey: ['sync'] }).finally(() => setMine(null))
      return
    }
    recalc()
      .then((result) => notify(syncSummary(run, result)))
      .catch(() => {}) // the query client toasts the failure
      .finally(() => {
        setMine(null)
        void qc.invalidateQueries()
      })
  }, [run, mine, qc, recalc])

  // A run that finished between two looks at the list, never seen running here.
  useEffect(() => {
    if (!runs.data) return
    const latest = latestFinished(runs.data)
    if (handled.current === undefined) {
      handled.current = latest
      return
    }
    if (latest <= handled.current || latest === mine) return
    handled.current = latest
    void qc.invalidateQueries()
  }, [runs.data, mine, qc])

  return {
    start: () => start.mutate(),
    isRunning: start.isPending || recalculate.isPending || watchId !== undefined,
    runs: runs.data,
  }
}
