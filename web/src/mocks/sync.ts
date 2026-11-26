import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'
import { settingsState } from './settings'

type Run = Schemas['SyncRunRead']

const initial = (): Run[] => [
  { id: 2, provider: 'simplefin', trigger: 'scheduled', status: 'success', started_at: '2026-10-02T06:00:00Z', finished_at: '2026-10-02T06:00:14Z', added: 6, updated: 2, error_text: null, requests: 1 },
  { id: 1, provider: 'simplefin', trigger: 'manual', status: 'error', started_at: '2026-10-01T18:30:00Z', finished_at: '2026-10-01T18:30:03Z', added: 0, updated: 0, error_text: 'Bank connection timed out', requests: 1 },
]

export let runs: Run[] = initial()
const polls = new Map<number, number>()

export function resetSync() {
  runs = initial()
  polls.clear()
}

const problem = (status: number, title: string, detail: string) =>
  HttpResponse.json({ title, status, detail }, { status })

export const syncHandlers = [
  // The header's Recalc (and the end of Sync): local recalculation, nothing to change in the mocks.
  http.post('/api/recalculate', () =>
    HttpResponse.json<Schemas['RecalculateRead']>({ recategorized: 0, categorized: 0, recurring_changes: 0 }),
  ),
  http.get('/api/sync/schedule', () =>
    HttpResponse.json<Schemas['SyncSchedule']>({
      enabled: true,
      interval_hours: 6,
      next_run_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
    }),
  ),
  http.get('/api/sync/runs', () => HttpResponse.json<Run[]>(runs)),
  http.get('/api/sync/runs/:id', ({ params }) => {
    const run = runs.find((r) => r.id === Number(params.id))
    if (!run) return problem(404, 'Not Found', 'Sync run not found')
    if (run.status === 'running') {
      const n = (polls.get(run.id) ?? 0) + 1
      polls.set(run.id, n)
      if (n >= 2) {
        Object.assign(run, { status: 'success', finished_at: new Date().toISOString(), added: 4, updated: 1 })
      }
    }
    return HttpResponse.json<Run>(run)
  }),
  http.post('/api/sync', () => {
    if (!settingsState.simplefin.connected) return problem(409, 'Conflict', 'No bank connection is configured')
    if (runs.some((r) => r.status === 'running')) return problem(409, 'Conflict', 'A sync is already running')
    const run: Run = {
      id: Math.max(0, ...runs.map((r) => r.id)) + 1,
      provider: 'simplefin',
      trigger: 'manual',
      status: 'running',
      started_at: new Date().toISOString(),
      finished_at: null,
      added: 0,
      updated: 0,
      error_text: null,
      requests: 1,
    }
    runs.unshift(run)
    return HttpResponse.json<Run>(run, { status: 202 })
  }),
]
