/**
 * The scheduler: firstRunAt, then the setTimeout chain (an interval job with 120 s of jitter,
 * coalesce, one instance at a time, a one-second misfire grace, and jitter added to the
 * previous jittered run time).
 *
 * Fake timers fake Date too, so the scheduler's default clock follows them.
 */

import { count, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import type { RuntimeDefaults } from '../src/config.js'
import type { Db } from '../src/db/index.js'
import { syncRuns } from '../src/db/schema.js'
import { createLogger, silentLogger } from '../src/lib/log.js'
import {
  JITTER_SECONDS,
  MISFIRE_GRACE_SECONDS,
  OVERDUE_DELAY_MS,
  type Scheduler,
  createScheduler,
  firstRunAt,
  runScheduledSync,
} from '../src/scheduler.js'
import { KeySecretStore } from '../src/secrets.js'
import { SIMPLEFIN_ACCESS_URL, setSetting } from '../src/services/app_settings.js'
import { updateConfig } from '../src/services/config.js'
import * as sync from '../src/services/sync.js'
import { ACCESS_URL, mockFetch } from './factories.js'
import { makeDb, testConfig } from './setup.js'

const NOW = new Date('2026-10-03T12:00:00.000Z')
const HOUR = 3_600_000
const SIX_HOURS = 6 * HOUR
const MINUTE = 60_000
const config = testConfig()
const secrets = new KeySecretStore(config.secretKey)

const at = (ms: number) => new Date(ms).toISOString()

describe('firstRunAt', () => {
  it('first run keeps cadence after restart', () => {
    const last = new Date(NOW.getTime() - 2 * HOUR)
    expect(firstRunAt(last, SIX_HOURS, NOW)).toEqual(new Date(last.getTime() + SIX_HOURS))
  })

  it('first run soon when overdue or never synced', () => {
    expect(firstRunAt(new Date(NOW.getTime() - 9 * HOUR), SIX_HOURS, NOW)).toEqual(new Date(NOW.getTime() + 2 * MINUTE))
    expect(firstRunAt(null, SIX_HOURS, NOW)).toEqual(new Date(NOW.getTime() + 2 * MINUTE))
  })
})

describe('GET /api/sync/schedule', () => {
  function appWith(scheduler?: { nextRunAt(): string | null; reschedule(): void }) {
    return createApp({
      db: makeDb(),
      config,
      secrets,
      log: silentLogger(),
      ...(scheduler === undefined ? {} : { scheduler }),
    })
  }

  it('schedule endpoint', async () => {
    const app = appWith({ nextRunAt: () => at(NOW.getTime() + SIX_HOURS), reschedule: () => {} })
    const body = (await (await app.request('/api/sync/schedule')).json()) as Record<string, unknown>
    expect(body.interval_hours).toBe(6)
    expect(String(body.next_run_at).startsWith('2026-10-03T18:00:00')).toBe(true)
  })

  it('reports no next run without a scheduler, and the configured enabled flag', async () => {
    const body = (await (await appWith().request('/api/sync/schedule')).json()) as Record<string, unknown>
    expect(body).toEqual({ enabled: false, interval_hours: 6, next_run_at: null })
  })
})

describe('scheduler timer', () => {
  let db: Db
  let scheduler: Scheduler | null
  let lines: string[]

  const enabled = (overrides: Partial<RuntimeDefaults> = {}): RuntimeDefaults => ({
    ...config.defaults,
    schedulerEnabled: true,
    ...overrides,
  })

  function make(
    job: () => Promise<void>,
    { random = 0.5, defaults = enabled() }: { random?: number; defaults?: RuntimeDefaults } = {},
  ): Scheduler {
    scheduler = createScheduler({
      db,
      secrets,
      defaults,
      log: createLogger({ level: 'debug' }, { write: (line: string) => void lines.push(line) }),
      random: () => random,
      job,
    })
    return scheduler
  }

  const logged = (msg: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === msg)

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
    db = makeDb()
    scheduler = null
    lines = []
  })

  afterEach(() => {
    scheduler?.stop()
    vi.useRealTimers()
  })

  it('stays off when the config disables it', () => {
    const s = make(vi.fn(async () => {}), { defaults: enabled({ schedulerEnabled: false }) })
    expect(s.start()).toBe(false)
    expect(s.nextRunAt()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs soon after a first start, then every interval plus jitter', async () => {
    const job = vi.fn(async () => {})
    const s = make(job)
    expect(s.nextRunAt()).toBeNull()
    expect(s.start()).toBe(true)
    const first = NOW.getTime() + OVERDUE_DELAY_MS
    expect(s.nextRunAt()).toBe(at(first))

    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS - 1)
    expect(job).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(job).toHaveBeenCalledTimes(1)
    const second = first + SIX_HOURS + 0.5 * JITTER_SECONDS * 1000
    expect(s.nextRunAt()).toBe(at(second))

    await vi.advanceTimersByTimeAsync(second - Date.now())
    expect(job).toHaveBeenCalledTimes(2)
    // The interval is added to the previous jittered run time, so jitter accumulates.
    expect(s.nextRunAt()).toBe(at(second + SIX_HOURS + 0.5 * JITTER_SECONDS * 1000))
  })

  it('jitter stays between zero and 120 seconds', async () => {
    for (const [random, jitter] of [
      [0, 0],
      [0.999, 0.999 * JITTER_SECONDS * 1000],
    ] as const) {
      const s = make(vi.fn(async () => {}), { random })
      s.start()
      await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
      expect(Date.parse(s.nextRunAt() as string) - Date.now()).toBe(SIX_HOURS + jitter)
      s.stop()
    }
  })

  it('keeps the cadence of the last sync across a restart', () => {
    db.insert(syncRuns)
      .values({ provider: 'simplefin', trigger: 'scheduled', status: 'success', started_at: at(NOW.getTime() - 2 * HOUR) })
      .run()
    const s = make(vi.fn(async () => {}))
    s.start()
    expect(s.nextRunAt()).toBe(at(NOW.getTime() + 4 * HOUR))
  })

  it('reads the interval from the config service', () => {
    db.insert(syncRuns)
      .values({ provider: 'simplefin', trigger: 'scheduled', status: 'success', started_at: at(NOW.getTime() - HOUR) })
      .run()
    const s = make(vi.fn(async () => {}), { defaults: enabled({ syncIntervalHours: 3 }) })
    s.start()
    expect(s.nextRunAt()).toBe(at(NOW.getTime() + 2 * HOUR))
  })

  it('falls back to soon when the last sync cannot be read', () => {
    db.$client.exec('DROP TABLE sync_runs')
    const s = make(vi.fn(async () => {}))
    s.start()
    expect(s.nextRunAt()).toBe(at(NOW.getTime() + OVERDUE_DELAY_MS))
    expect(logged('scheduler_last_sync_unknown')).toHaveLength(1)
  })

  it('start is idempotent and stop clears the timer', async () => {
    const job = vi.fn(async () => {})
    const s = make(job)
    s.start()
    expect(s.start()).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    s.stop()
    expect(s.nextRunAt()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(SIX_HOURS)
    expect(job).not.toHaveBeenCalled()
  })

  it('runs one instance at a time (max_instances=1)', async () => {
    let finish: () => void = () => {}
    const job = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const s = make(job)
    s.start()
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    expect(job).toHaveBeenCalledTimes(1)
    const second = Date.parse(s.nextRunAt() as string)
    await vi.advanceTimersByTimeAsync(second - Date.now())
    expect(job).toHaveBeenCalledTimes(1)
    expect(logged('scheduled_sync_max_instances')).toHaveLength(1)
    expect(Date.parse(s.nextRunAt() as string)).toBeGreaterThan(second)
    finish()
    await s.idle()
    await vi.advanceTimersByTimeAsync(Date.parse(s.nextRunAt() as string) - Date.now())
    expect(job).toHaveBeenCalledTimes(2)
  })

  it('skips a run that fires more than the misfire grace late', async () => {
    const job = vi.fn(async () => {})
    const s = make(job)
    s.start()
    const due = NOW.getTime() + OVERDUE_DELAY_MS
    // The clock jumps (a sleeping laptop) without the timer firing early.
    vi.setSystemTime(NOW.getTime() + (MISFIRE_GRACE_SECONDS + 9) * 1000)
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    expect(job).not.toHaveBeenCalled()
    expect(logged('scheduled_sync_missed')).toHaveLength(1)
    expect(s.nextRunAt()).toBe(at(due + SIX_HOURS + 60_000))
  })

  it('runs a run that fires within the misfire grace', async () => {
    const job = vi.fn(async () => {})
    const s = make(job)
    s.start()
    vi.setSystemTime(NOW.getTime() + MISFIRE_GRACE_SECONDS * 1000)
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    expect(job).toHaveBeenCalledTimes(1)
  })

  it('coalesces missed runs into the last one before now', async () => {
    const job = vi.fn(async () => {})
    const s = make(job)
    s.start()
    const due = NOW.getTime() + OVERDUE_DELAY_MS
    const step = SIX_HOURS + 60_000
    vi.setSystemTime(NOW.getTime() + 13 * HOUR)
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    // due, due + step, and due + 2 steps are past; the last is too late to run, so the next
    // run is one step after it.
    expect(job).not.toHaveBeenCalled()
    expect(s.nextRunAt()).toBe(at(due + 3 * step))
  })

  it('handles intervals longer than setTimeout can wait', async () => {
    const job = vi.fn(async () => {})
    const s = make(job, { defaults: enabled({ syncIntervalHours: 1000 }) })
    s.start()
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    expect(job).toHaveBeenCalledTimes(1)
    const next = Date.parse(s.nextRunAt() as string)
    expect(next - Date.now()).toBe(1000 * HOUR + 60_000)
    await vi.advanceTimersByTimeAsync(2 ** 31)
    expect(job).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(next - Date.now())
    expect(job).toHaveBeenCalledTimes(2)
  })

  it('a failing job is logged and the next run still comes', async () => {
    const job = vi.fn(async () => {
      throw new Error('boom')
    })
    const s = make(job)
    s.start()
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    await s.idle()
    expect(logged('scheduled_sync_crashed')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(Date.parse(s.nextRunAt() as string) - Date.now())
    expect(job).toHaveBeenCalledTimes(2)
  })

  it('runs the scheduled sync by default', async () => {
    setSetting(db, secrets, SIMPLEFIN_ACCESS_URL, ACCESS_URL, { encrypt: true })
    vi.stubGlobal('fetch', mockFetch())
    try {
      scheduler = createScheduler({ db, secrets, defaults: enabled(), log: silentLogger(), random: () => 0 })
      scheduler.start()
      await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
      await scheduler.idle()
      const runs = db.select().from(syncRuns).all()
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({ trigger: 'scheduled', status: 'success', added: 295 })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('scheduler follows config changes (backlog 31)', () => {
  let db: Db
  let scheduler: Scheduler | null

  const enabled = (overrides: Partial<RuntimeDefaults> = {}): RuntimeDefaults => ({
    ...config.defaults,
    schedulerEnabled: true,
    ...overrides,
  })

  function make(job: () => Promise<void>, defaults: RuntimeDefaults = enabled()): Scheduler {
    scheduler = createScheduler({ db, secrets, defaults, log: silentLogger(), random: () => 0.5, job })
    return scheduler
  }

  /** PUT /api/settings/config's store, without the route. */
  const store = (changes: Parameters<typeof updateConfig>[3], defaults: RuntimeDefaults = enabled()) =>
    updateConfig(db, secrets, defaults, changes)

  const lastSync = (msAgo: number) =>
    db.insert(syncRuns)
      .values({ provider: 'simplefin', trigger: 'scheduled', status: 'success', started_at: at(Date.now() - msAgo) })
      .run()

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
    db = makeDb()
    scheduler = null
  })

  afterEach(() => {
    scheduler?.stop()
    vi.useRealTimers()
  })

  it('a shorter interval re-arms from the last sync start, like firstRunAt', async () => {
    lastSync(HOUR)
    const job = vi.fn(async () => {})
    const s = make(job)
    s.start()
    expect(s.nextRunAt()).toBe(at(NOW.getTime() + 5 * HOUR))
    store({ sync_interval_hours: 3 })
    s.reschedule()
    expect(s.nextRunAt()).toBe(at(NOW.getTime() + 2 * HOUR))
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(job).toHaveBeenCalledTimes(1)
    // Later runs use the new interval.
    expect(s.nextRunAt()).toBe(at(NOW.getTime() + 2 * HOUR + 3 * HOUR + 0.5 * JITTER_SECONDS * 1000))
  })

  it('a shorter interval that is already overdue makes a sync due soon', async () => {
    lastSync(4 * HOUR)
    const job = vi.fn(async () => {})
    const s = make(job)
    s.start()
    store({ sync_interval_hours: 2 })
    s.reschedule()
    expect(s.nextRunAt()).toBe(at(NOW.getTime() + OVERDUE_DELAY_MS))
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    expect(job).toHaveBeenCalledTimes(1)
  })

  it('a longer interval moves the next run later', () => {
    lastSync(HOUR)
    const s = make(vi.fn(async () => {}))
    s.start()
    store({ sync_interval_hours: 12 })
    s.reschedule()
    expect(s.nextRunAt()).toBe(at(NOW.getTime() + 11 * HOUR))
  })

  it('turning it off stops it without a restart', async () => {
    const job = vi.fn(async () => {})
    const s = make(job)
    s.start()
    store({ scheduler_enabled: false })
    s.reschedule()
    expect(s.nextRunAt()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2 * SIX_HOURS)
    expect(job).not.toHaveBeenCalled()
  })

  it('a process started disabled picks up a later enable', async () => {
    const job = vi.fn(async () => {})
    const defaults = enabled({ schedulerEnabled: false })
    const s = make(job, defaults)
    expect(s.start()).toBe(false)
    expect(s.nextRunAt()).toBeNull()
    store({ scheduler_enabled: true }, defaults)
    s.reschedule()
    expect(s.nextRunAt()).toBe(at(NOW.getTime() + OVERDUE_DELAY_MS))
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    expect(job).toHaveBeenCalledTimes(1)
    // And off again, then on again.
    store({ scheduler_enabled: false }, defaults)
    s.reschedule()
    expect(s.nextRunAt()).toBeNull()
    store({ scheduler_enabled: true }, defaults)
    s.reschedule()
    expect(s.nextRunAt()).not.toBeNull()
  })

  it('a change that leaves the schedule alone keeps the next run, jitter included', async () => {
    const s = make(vi.fn(async () => {}))
    s.start()
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    const next = s.nextRunAt()
    store({ llm_model: 'another-model', sync_interval_hours: 6 })
    s.reschedule()
    expect(s.nextRunAt()).toBe(next)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('the timer reads the stored interval each time it arms', async () => {
    const job = vi.fn(async () => {})
    const s = make(job)
    s.start()
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    const second = Date.parse(s.nextRunAt() as string)
    // Stored without a reschedule: the armed run stays, the one after uses the new interval.
    store({ sync_interval_hours: 3 })
    await vi.advanceTimersByTimeAsync(second - Date.now())
    expect(job).toHaveBeenCalledTimes(2)
    expect(s.nextRunAt()).toBe(at(second + 3 * HOUR + 0.5 * JITTER_SECONDS * 1000))
  })

  it('the timer reads the stored on/off switch each time it fires', async () => {
    const job = vi.fn(async () => {})
    const s = make(job)
    s.start()
    store({ scheduler_enabled: false })
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    expect(job).not.toHaveBeenCalled()
    expect(s.nextRunAt()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    store({ scheduler_enabled: true })
    s.reschedule()
    expect(s.nextRunAt()).not.toBeNull()
  })

  it('keeps the interval clamp (backlog 33) after a reschedule', async () => {
    const job = vi.fn(async () => {})
    const s = make(job)
    s.start()
    store({ sync_interval_hours: 0 })
    s.reschedule()
    expect(s.nextRunAt()).toBe(at(NOW.getTime() + OVERDUE_DELAY_MS))
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    expect(job).toHaveBeenCalledTimes(1)
    expect(Date.parse(s.nextRunAt() as string) - Date.now()).toBe(1000 + 0.5 * JITTER_SECONDS * 1000)
  })

  it('a reschedule during a run never interrupts it and arms after it ends', async () => {
    let finish: () => void = () => {}
    const job = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const s = make(job)
    s.start()
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    expect(job).toHaveBeenCalledTimes(1)
    lastSync(0) // the running sync's row
    store({ sync_interval_hours: 1 })
    s.reschedule()
    expect(vi.getTimerCount()).toBe(0)
    // The schedule shows where the run would go now.
    expect(s.nextRunAt()).toBe(at(Date.now() + HOUR))
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    expect(job).toHaveBeenCalledTimes(1)
    const ended = Date.now()
    finish()
    await s.idle()
    // Armed when the run ends, from the run's start and the new interval: overdue, so soon.
    expect(vi.getTimerCount()).toBe(1)
    expect(s.nextRunAt()).toBe(at(ended + OVERDUE_DELAY_MS))
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    expect(job).toHaveBeenCalledTimes(2)
  })

  it('a reschedule during a run that turns it off leaves it off', async () => {
    let finish: () => void = () => {}
    const job = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const s = make(job)
    s.start()
    await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
    store({ scheduler_enabled: false })
    s.reschedule()
    expect(s.nextRunAt()).toBeNull()
    finish()
    await s.idle()
    expect(s.nextRunAt()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does nothing after stop or before start', () => {
    const s = make(vi.fn(async () => {}))
    s.reschedule()
    expect(s.nextRunAt()).toBeNull()
    s.start()
    s.stop()
    s.reschedule()
    expect(s.nextRunAt()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('run_scheduled_sync', () => {
  let db: Db
  let lines: string[]
  const log = () => createLogger({ level: 'debug' }, { write: (line: string) => void lines.push(line) })
  const entries = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>)
  const runCount = () => db.select({ n: count() }).from(syncRuns).get()?.n

  beforeEach(() => {
    db = makeDb()
    lines = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('skips quietly when SimpleFIN is not connected', async () => {
    await runScheduledSync(db, secrets, config.defaults, log())
    expect(runCount()).toBe(0)
    expect(entries()).toContainEqual(expect.objectContaining({ msg: 'scheduled_sync_skipped', reason: 'not_connected' }))
  })

  it('runs a scheduled sync when connected', async () => {
    setSetting(db, secrets, SIMPLEFIN_ACCESS_URL, ACCESS_URL, { encrypt: true })
    vi.stubGlobal('fetch', mockFetch())
    await runScheduledSync(db, secrets, config.defaults, log())
    const run = db.select().from(syncRuns).get()
    expect(run).toMatchObject({ trigger: 'scheduled', status: 'success', provider: 'simplefin' })
    expect(entries()).toContainEqual(
      expect.objectContaining({ msg: 'scheduled_sync_finished', run_id: run?.id, status: 'success' }),
    )
  })

  it('skips with the reason when a guard refuses', async () => {
    setSetting(db, secrets, SIMPLEFIN_ACCESS_URL, ACCESS_URL, { encrypt: true })
    const running = sync.startRun(db, secrets, config.defaults, 'simplefin', 'manual')
    await expect(runScheduledSync(db, secrets, config.defaults, log())).resolves.toBeUndefined()
    expect(entries()).toContainEqual(
      expect.objectContaining({ msg: 'scheduled_sync_skipped', reason: 'A sync is already running.' }),
    )
    expect(db.select().from(syncRuns).where(eq(syncRuns.id, running.id)).get()?.status).toBe('running')
  })

  it('logs and swallows anything else', async () => {
    db.$client.close()
    await expect(runScheduledSync(db, secrets, config.defaults, log())).resolves.toBeUndefined()
    expect(entries()).toContainEqual(expect.objectContaining({ msg: 'scheduled_sync_crashed' }))
  })
})
