/**
 * Background scheduler: one periodic sync job. Ports app/scheduler.py.
 *
 * APScheduler is replaced by a setTimeout chain (plan 5.8) that keeps what the Python job
 * asked for and what APScheduler did with it:
 * - The first run is `firstRunAt(...)`, without jitter. Each later run is the previous
 *   (jittered) run time plus the interval plus up to JITTER_SECONDS, so jitter accumulates.
 * - coalesce=True: when several run times have passed, only the last one is considered.
 * - max_instances=1: a run that comes due while the previous one is still going is skipped.
 * - misfire_grace_time (APScheduler's default, one second): a run that fires later than that
 *   (a sleeping machine, a blocked event loop) is skipped, and the next one is scheduled.
 * - next_run_time moves on when a run is submitted, before it finishes.
 * - shutdown(wait=False): `stop()` does not wait for a running sync.
 *
 * New: app/main.py's lifespan checked `scheduler_enabled` before starting; here `start()` reads
 * the interval and the enabled flag from the config service once and returns false when the
 * scheduler is off. A config change takes effect at the next start, as an env change did.
 * Python held the scheduler in a module global; here the caller owns the handle and passes it
 * to the app for GET /api/sync/schedule.
 */

import { max } from 'drizzle-orm'
import type { RuntimeDefaults } from './config.js'
import type { Db } from './db/index.js'
import { syncRuns } from './db/schema.js'
import { DomainError } from './lib/errors.js'
import { type Logger, silentLogger } from './lib/log.js'
import type { SecretStore } from './secrets.js'
import { runtimeConfig } from './services/config.js'
import { buildProvider, isConnected, runSync } from './services/sync.js'

export const JOB_ID = 'simplefin_sync'
export const JITTER_SECONDS = 120
export const OVERDUE_DELAY_MS = 2 * 60_000
/** APScheduler's default misfire_grace_time, which the Python job did not override. */
export const MISFIRE_GRACE_SECONDS = 1

const HOUR_MS = 3_600_000
/** setTimeout fires at once for longer delays, so a longer wait is chained. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/** Job body. Skips quietly when SimpleFIN is not connected or a guard refuses. */
export async function runScheduledSync(
  db: Db,
  secrets: SecretStore,
  defaults: RuntimeDefaults,
  log: Logger = silentLogger(),
): Promise<void> {
  try {
    if (!isConnected(db, secrets)) {
      log.info({ reason: 'not_connected' }, 'scheduled_sync_skipped')
      return
    }
    const provider = buildProvider(db, secrets)
    const run = await runSync(db, secrets, defaults, provider, 'scheduled', log)
    log.info({ run_id: run.id, status: run.status }, 'scheduled_sync_finished')
  } catch (err) {
    if (err instanceof DomainError) log.warn({ reason: err.detail }, 'scheduled_sync_skipped')
    else log.error({ err }, 'scheduled_sync_crashed')
  }
}

/** Keep the cadence across restarts: one interval after the last sync, or soon if overdue. */
export function firstRunAt(lastStarted: Date | null, intervalMs: number, now: Date): Date {
  const due = lastStarted !== null ? lastStarted.getTime() + intervalMs : now.getTime()
  return new Date(Math.max(due, now.getTime() + OVERDUE_DELAY_MS))
}

function lastSyncStarted(db: Db, log: Logger): Date | null {
  try {
    const last = db.select({ last: max(syncRuns.started_at) }).from(syncRuns).get()?.last
    return last ? new Date(last) : null
  } catch {
    // database not ready yet; fall back to "soon"
    log.warn('scheduler_last_sync_unknown')
    return null
  }
}

export interface SchedulerDeps {
  db: Db
  secrets: SecretStore
  defaults: RuntimeDefaults
  log?: Logger
  /** The clock; tests use fake timers, which fake Date too. */
  now?: () => Date
  /** random.uniform(0, 1) for the jitter. */
  random?: () => number
  /** The job body; runScheduledSync by default. */
  job?: () => Promise<void>
}

export interface Scheduler {
  /** Start the periodic sync if the config enables it. True when it is running. */
  start(): boolean
  /** Stop scheduling. A sync already running is not waited for. */
  stop(): void
  /** When the periodic sync will next fire (ISO UTC), or null when the scheduler is off. */
  nextRunAt(): string | null
  /** Resolves when no scheduled sync is running. */
  idle(): Promise<void>
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { db, secrets, defaults } = deps
  const log = deps.log ?? silentLogger()
  const now = deps.now ?? (() => new Date())
  const random = deps.random ?? Math.random
  const job = deps.job ?? (() => runScheduledSync(db, secrets, defaults, log))

  let intervalMs = 0
  let nextRun: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null

  /** IntervalTrigger.get_next_fire_time after a previous fire time, with jitter. */
  const nextFireTime = (previous: number): number => previous + intervalMs + random() * JITTER_SECONDS * 1000

  function arm(): void {
    if (nextRun === null) return
    const delay = Math.max(0, nextRun - now().getTime())
    timer = setTimeout(wake, Math.min(delay, MAX_TIMEOUT_MS))
  }

  function wake(): void {
    timer = null
    if (nextRun === null) return
    const current = now().getTime()
    if (current < nextRun) {
      arm()
      return
    }
    // Job._get_run_times, coalesced to the last run time not after now.
    let runTime = nextRun
    for (let t = nextFireTime(runTime); t <= current; t = nextFireTime(runTime)) runTime = t
    nextRun = nextFireTime(runTime)
    arm()
    submit(runTime, current)
  }

  function submit(runTime: number, current: number): void {
    if (running !== null) {
      log.warn({ job: JOB_ID }, 'scheduled_sync_max_instances')
      return
    }
    if (current - runTime > MISFIRE_GRACE_SECONDS * 1000) {
      log.warn({ job: JOB_ID, late_ms: current - runTime }, 'scheduled_sync_missed')
      return
    }
    running = (async () => {
      try {
        await job()
      } catch (err) {
        log.error({ err }, 'scheduled_sync_crashed')
      } finally {
        running = null
      }
    })()
  }

  return {
    start() {
      if (nextRun !== null) return true
      const config = runtimeConfig(db, secrets, defaults)
      if (!config.schedulerEnabled) return false
      // APScheduler runs a zero interval every second. A negative one, which would loop
      // forever there, is held to a second too.
      const interval = config.syncIntervalHours * HOUR_MS
      intervalMs = Math.max(interval, 1000)
      nextRun = firstRunAt(lastSyncStarted(db, log), interval, now()).getTime()
      arm()
      return true
    },
    stop() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      nextRun = null
    },
    nextRunAt() {
      return nextRun === null ? null : new Date(nextRun).toISOString()
    },
    async idle() {
      while (running !== null) await running
    },
  }
}
