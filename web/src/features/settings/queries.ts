import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'

export const SYNC_POLL_MS = 2000

export const useSimplefinStatus = () =>
  useQuery({ queryKey: ['settings', 'simplefin'], queryFn: () => unwrap(api.GET('/api/settings/simplefin')) })

export const useLlmStatus = () =>
  useQuery({ queryKey: ['settings', 'llm'], queryFn: () => unwrap(api.GET('/api/settings/llm')) })

export const useHealth = () =>
  useQuery({ queryKey: ['health'], queryFn: () => unwrap(api.GET('/api/health')), staleTime: Infinity })

export const useAccounts = () =>
  useQuery({ queryKey: ['accounts'], queryFn: () => unwrap(api.GET('/api/accounts')) })

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
  })

export function useConnectSimplefin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (setup_token: string) =>
      unwrap(api.POST('/api/settings/simplefin', { body: { setup_token } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'simplefin'] }),
    // Shown under the token field.
    meta: { inlineError: true },
  })
}

export function useDisconnectSimplefin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/settings/simplefin')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'simplefin'] }),
  })
}

/**
 * Sync state for the page: starts runs, and while one is running polls it every 2s.
 * When it finishes, everything the sync may have changed is refetched.
 */
export function useSync() {
  const qc = useQueryClient()
  const runs = useSyncRuns()
  const runningId = runs.data?.find((r) => r.status === 'running')?.id

  const start = useMutation({
    mutationFn: () => unwrap(api.POST('/api/sync')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sync', 'runs'] }),
    // The Settings page shows it with the run's own failures.
    meta: { inlineError: true },
  })

  const polled = useQuery({
    queryKey: ['sync', 'run', runningId],
    queryFn: () => unwrap(api.GET('/api/sync/runs/{run_id}', { params: { path: { run_id: runningId! } } })),
    enabled: runningId !== undefined,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? SYNC_POLL_MS : false),
    gcTime: 0,
  })

  const finished = polled.data && polled.data.status !== 'running'
  useEffect(() => {
    if (!finished) return
    for (const key of ['sync', 'accounts', 'transactions']) qc.invalidateQueries({ queryKey: [key] })
  }, [finished, qc])

  return {
    start: start.mutate,
    isRunning: start.isPending || runningId !== undefined,
    error: (start.error ?? polled.error)?.message,
  }
}
