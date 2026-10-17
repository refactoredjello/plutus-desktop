export const DAILY_REQUEST_BUDGET = 24
const DAY_MS = 24 * 60 * 60 * 1000

/** SimpleFIN requests used by runs started in the last 24 hours. */
export function requestsInLastDay(runs: { started_at: string; requests: number }[], now = Date.now()) {
  return runs.filter((r) => now - new Date(r.started_at).getTime() < DAY_MS).reduce((sum, r) => sum + r.requests, 0)
}

