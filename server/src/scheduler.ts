/**
 * Background scheduler: one periodic sync job on a setTimeout chain.
 *
 * - The first run is `firstRunAt(...)`, without jitter. Each later run is the previous
 *   (jittered) run time plus the interval plus up to JITTER_SECONDS, so jitter accumulates.
 * - Coalesce: when several run times have passed, only the last one is considered.
 * - One at a time: a run that comes due while the previous one is still going is skipped.
 * - Misfire grace (one second): a run that fires later than that (a sleeping machine, a
 *   blocked event loop) is skipped, and the next one is scheduled.
 * - The next run time moves on when a run is submitted, before it finishes.
 * - `stop()` does not wait for a running sync.
 *
 * The knobs live in the config service and Settings can change them at run time (backlog 31,
 * fixed with the owner's approval), so:
 * - `start()` arms the first run after launch with `firstRunAt`, and returns false when the
 *   scheduler is off. It still marks the scheduler started, so a later enable is picked up.
 * - The timer reads the stored config each time it fires and arms the next run: the next run
 *   uses the stored interval, and a stored "off" stops it there without running.
 * - `reschedule()`, called by PUT /api/settings/config, cancels and re-arms from the stored
 *   config: off clears the timer; on computes the next run from the last sync start and the
 *   new interval with `firstRunAt`, as after a restart. A shorter interval can therefore make
 *   a sync due at once, which `firstRunAt` holds to OVERDUE_DELAY_MS from now. When neither
 *   the switch nor the interval changed, the armed run (jitter included) is kept, so editing
 *   an unrelated setting doesn't move the schedule.
 * - A reschedule never interrupts a running sync. During one it clears the timer and shows a
 *   provisional next run; the real one is computed the same way when the run ends.
 * - The jitter, the misfire grace (backlog 29), the accumulating jitter (backlog 30), and the
 *   one-second interval clamp (backlog 33) are unchanged.
 * The caller owns the handle and passes it to the app for GET /api/sync/schedule and the
 * config route.
 */

import { max } from 'drizzle-orm'
import type { RuntimeDefaults } from './config.js'
import type { Db } from './db/index.js'
import { syncRuns } from './db/schema.js'
import { DomainError } from './lib/errors.js'
import { type Logger, silentLogger } from './lib/log.js'
import type { SecretStore } from './secrets.js'
import { type RuntimeConfig, runtimeConfig } from './services/config.js'
import { buildProvider, isConnected, runSync } from './services/sync.js'

export const JOB_ID = 'simplefin_sync'
export const JITTER_SECONDS = 120
export const OVERDUE_DELAY_MS = 2 * 60_000
/** A run that fires later than this after its time is skipped (backlog 29). */
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
  /** Re-read the stored config and cancel and re-arm to match it. A no-op unless started. */
  reschedule(): void
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

  let started = false
  let intervalMs = 0
  let nextRun: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  /** A reschedule came during a run; it is applied when the run ends. */
  let pending = false

  /** IntervalTrigger.get_next_fire_time after a previous fire time, with jitter. */
  const nextFireTime = (previous: number): number => previous + intervalMs + random() * JITTER_SECONDS * 1000

  /** The stored config, or null when it can't be read (the caller keeps what it has). */
  function readConfig(): RuntimeConfig | null {
    try {
      return runtimeConfig(db, secrets, defaults)
    } catch (err) {
      log.warn({ err }, 'scheduler_config_unknown')
      return null
    }
  }

  /** The interval in ms, held to at least a second, so a zero or negative interval runs
   * every second (backlog 33). */
  const clampedInterval = (config: RuntimeConfig): number => Math.max(config.syncIntervalHours * HOUR_MS, 1000)

  /** The first run after launch, and after a config change: firstRunAt from the last sync. */
  function firstRun(config: RuntimeConfig): number {
    intervalMs = clampedInterval(config)
    return firstRunAt(lastSyncStarted(db, log), config.syncIntervalHours * HOUR_MS, now()).getTime()
  }

  function cancel(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

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
    // Read the stored config each time the next run is armed.
    const config = readConfig()
    if (config !== null && !config.schedulerEnabled) {
      nextRun = null
      log.info({ job: JOB_ID }, 'scheduler_disabled')
      return
    }
    if (config !== null) intervalMs = clampedInterval(config)
    // The run times that have passed, coalesced to the last one not after now.
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
        if (pending) {
          pending = false
          rearm(true)
        }
      }
    })()
  }

  /** Cancel and re-arm from the stored config; `force` re-arms even when nothing changed. */
  function rearm(force: boolean): void {
    if (!started) return
    const config = readConfig()
    if (config === null) return
    if (!config.schedulerEnabled) {
      cancel()
      nextRun = null
      pending = false
      return
    }
    if (!force && !pending && nextRun !== null && clampedInterval(config) === intervalMs) return
    cancel()
    nextRun = firstRun(config)
    if (running !== null) {
      // Never interrupt a run: nextRun is provisional until it ends, then computed again.
      pending = true
      return
    }
    arm()
  }

  return {
    start() {
      started = true
      if (nextRun !== null) return true
      const config = runtimeConfig(db, secrets, defaults)
      if (!config.schedulerEnabled) return false
      nextRun = firstRun(config)
      arm()
      return true
    },
    reschedule() {
      rearm(false)
    },
    stop() {
      cancel()
      started = false
      pending = false
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
