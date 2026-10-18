/**
 * Ports api/tests/test_sync.py.
 *
 * Python passed `Settings(secret_key=...)`; here the history window comes from the config
 * service, so the calls take the secret store and the config defaults that seed it (180 days,
 * as in Python). The provider's fetch is async, so run_sync is too.
 *
 * The block after the port is not in Python: it pins what the port had to spell out (the
 * pipeline steps after the upsert, the request count, the error text, the clock the window
 * reads) and the detached background run that FastAPI's BackgroundTasks used to own.
 */

import { count, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/db/index.js'
import {
  accounts,
  appSettings,
  balanceSnapshots,
  categorizations,
  merchantClassifications,
  recurrences,
  rules,
  syncRuns,
  transactions,
} from '../src/db/schema.js'
import { type PlainDate, addDays, daysBetween, fromParts } from '../src/lib/dates.js'
import { ConflictError, ProviderError } from '../src/lib/errors.js'
import { silentLogger } from '../src/lib/log.js'
import { parseMoney } from '../src/lib/money.js'
import { SimpleFINProvider } from '../src/providers/bank/simplefin.js'
import type { BankProvider, ProviderSnapshot, ProviderTransaction } from '../src/providers/bank/types.js'
import { KeySecretStore } from '../src/secrets.js'
import * as appSettingsService from '../src/services/app_settings.js'
import { runtimeConfig } from '../src/services/config.js'
import * as sync from '../src/services/sync.js'
import * as demo from '../scripts/demo.js'
import { ACCESS_URL, mockFetch } from './factories.js'
import { makeDb, testConfig } from './setup.js'

const config = testConfig()
const defaults = config.defaults
const secrets = new KeySecretStore(config.secretKey)
const DAY_MS = 86_400_000

let db: Db

beforeEach(() => {
  db = makeDb()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

class FakeProvider implements BankProvider {
  readonly name = 'simplefin'
  readonly snapshots: ProviderSnapshot[]
  readonly windows: [PlainDate, PlainDate][] = []

  constructor(...snapshots: ProviderSnapshot[]) {
    this.snapshots = snapshots
  }

  async fetch(start: PlainDate, end: PlainDate): Promise<ProviderSnapshot> {
    this.windows.push([start, end])
    const next = this.snapshots.shift()
    if (next === undefined) throw new Error('pop from empty list')
    return next
  }
}

function tx(
  ext: string,
  { pending = false, amount = '-5.00', day = 1, postedOn }: { pending?: boolean; amount?: string; day?: number; postedOn?: PlainDate } = {},
): ProviderTransaction {
  const posted = postedOn ?? fromParts(2026, 10, day)
  return {
    external_id: ext,
    posted_on: posted,
    amount: parseMoney(amount),
    description: 'COFFEE',
    payee: null,
    memo: null,
    pending,
    transacted_at: pending ? `${posted}T00:00:00.000Z` : null,
  }
}

function snap(txs: ProviderTransaction[] = [], errors: string[] = []): ProviderSnapshot {
  return {
    accounts: [
      {
        external_id: 'A1',
        name: 'Checking',
        type: 'checking',
        institution_name: 'Bank',
        currency: 'USD',
        balance: parseMoney('100.00'),
        available: null,
        balance_as_of: '2026-10-03T00:00:00.000Z',
        transactions: txs,
      },
    ],
    errors,
  }
}

function rows(table: typeof accounts | typeof transactions | typeof balanceSnapshots | typeof syncRuns): number {
  return db.select({ n: count() }).from(table).get()?.n ?? 0
}

function run(provider: BankProvider, trigger: 'manual' | 'scheduled' = 'manual') {
  return sync.runSync(db, secrets, defaults, provider, trigger)
}

/** datetime.now(UTC) - delta, as the timestamps the sync stores. */
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

/** (dt - timedelta(days=n)).date() of an ISO timestamp. */
function dateBefore(timestamp: string, days: number): PlainDate {
  return new Date(Date.parse(timestamp) - days * DAY_MS).toISOString().slice(0, 10) as PlainDate
}

function insertRun(values: Partial<typeof syncRuns.$inferInsert> & { started_at: string }) {
  return db
    .insert(syncRuns)
    .values({ provider: 'simplefin', trigger: 'scheduled', status: 'success', ...values })
    .returning()
    .get()
}

describe('sync (test_sync.py)', () => {
  it('test_first_and_second_sync_with_fixture', async () => {
    const provider = new SimpleFINProvider(ACCESS_URL, mockFetch())
    const run1 = await run(provider)
    expect(run1.status).toBe('success')
    expect(run1.added).toBe(295)
    expect(run1.updated).toBe(0)
    expect(run1.finished_at).not.toBeNull()
    expect(rows(accounts)).toBe(3)
    expect(rows(transactions)).toBe(295)
    expect(rows(balanceSnapshots)).toBe(3)

    const run2 = await run(provider, 'scheduled')
    expect(run2.status).toBe('success')
    expect(run2.added).toBe(0)
    expect(run2.updated).toBe(0)
    expect(rows(transactions)).toBe(295)
    expect(rows(balanceSnapshots)).toBe(6)
  })

  it('test_window_first_run_and_overlap', async () => {
    const provider = new FakeProvider(snap(), snap())
    const first = await run(provider)
    const [start, end] = provider.windows[0] as [PlainDate, PlainDate]
    expect(daysBetween(start, end)).toBe(180)
    expect(runtimeConfig(db, secrets, defaults).syncFirstHistoryDays).toBe(180)
    await run(provider)
    const [start2] = provider.windows[1] as [PlainDate, PlainDate]
    expect(start2).toBe(dateBefore(first.started_at, 5))
  })

  it('test_changed_field_counts_as_update', async () => {
    const provider = new FakeProvider(snap([tx('T1')]), snap([tx('T1', { amount: '-6.00' })]))
    await run(provider)
    const second = await run(provider)
    expect([second.added, second.updated]).toEqual([0, 1])
  })

  it('test_pending_posts_in_place_and_with_new_id', async () => {
    // Posted today: a stale pending row is only dropped inside the second run's overlap window.
    const today = new Date().toISOString().slice(0, 10) as PlainDate
    const provider = new FakeProvider(
      snap([tx('P1', { pending: true, postedOn: today }), tx('P2', { pending: true, postedOn: today })]),
      // P1 posts under the same id; P2 posts under a new id
      snap([tx('P1', { postedOn: today }), tx('POSTED2', { postedOn: today })]),
    )
    await run(provider)
    const second = await run(provider)
    const stored = new Map(db.select().from(transactions).all().map((t) => [t.external_id, t]))
    expect(new Set(stored.keys())).toEqual(new Set(['P1', 'POSTED2']))
    expect([...stored.values()].some((t) => t.pending)).toBe(false)
    expect([second.added, second.updated]).toEqual([1, 1])
  })

  it('test_provider_errors_mark_run_error_and_keep_pending', async () => {
    const provider = new FakeProvider(snap([tx('P1', { pending: true })]), snap([], ['Bank needs attention']))
    await run(provider)
    const second = await run(provider)
    expect(second.status).toBe('error')
    expect(second.error_text).toBeTruthy()
    expect(second.error_text).toContain('Bank needs attention')
    expect(rows(transactions)).toBe(1)
  })

  it('test_provider_exception_marks_run_error', async () => {
    const boom: BankProvider = {
      name: 'simplefin',
      fetch: async () => {
        throw new Error('kaput')
      },
    }
    const result = await run(boom)
    expect(result.status).toBe('error')
    expect(result.error_text).toBeTruthy()
    expect(result.error_text).toContain('kaput')
    expect(result.finished_at).not.toBeNull()
  })

  it('test_guard_refuses_concurrent_run', async () => {
    sync.startRun(db, secrets, defaults, 'simplefin', 'manual')
    const attempt = run(new FakeProvider(snap()))
    await expect(attempt).rejects.toBeInstanceOf(ConflictError)
    await expect(attempt).rejects.toThrow(/already running/)
  })

  it('test_guard_refuses_over_daily_budget', async () => {
    const now = Date.now()
    insertRun({
      started_at: new Date(now - 5 * 60_000).toISOString(),
      requests: sync.DAILY_REQUEST_BUDGET - 1, // 23 used; a 1-request incremental sync fits
    })
    const ok = await run(new FakeProvider(snap()))
    expect(ok.status).toBe('success')
    insertRun({ started_at: new Date(now - 60_000).toISOString(), requests: 1 })
    const attempt = run(new FakeProvider(snap()))
    await expect(attempt).rejects.toBeInstanceOf(ConflictError)
    await expect(attempt).rejects.toThrow(/budget/)
  })

  it('test_old_runs_do_not_count_toward_budget', async () => {
    const old = ago(30 * 3_600_000)
    for (let i = 0; i < 25; i++) insertRun({ started_at: old })
    const result = await run(new FakeProvider(snap()))
    expect(result.status).toBe('success')
  })

  it('test_encryption_round_trip_and_not_plaintext', () => {
    appSettingsService.setSetting(db, secrets, appSettingsService.SIMPLEFIN_ACCESS_URL, ACCESS_URL, { encrypt: true })
    const row = db.select().from(appSettings).where(eq(appSettings.key, appSettingsService.SIMPLEFIN_ACCESS_URL)).get()
    expect(row).toBeDefined()
    expect(row?.is_encrypted).toBe(true)
    expect(row?.value).not.toContain('pass456')
    expect(row?.value).not.toContain('bridge.example')
    const raw = db.$client.prepare('select value from app_settings').pluck().all() as string[]
    expect(raw).toHaveLength(1)
    expect(raw[0]).not.toContain('pass456')
    expect(appSettingsService.getSetting(db, secrets, appSettingsService.SIMPLEFIN_ACCESS_URL)).toBe(ACCESS_URL)
    appSettingsService.deleteSetting(db, appSettingsService.SIMPLEFIN_ACCESS_URL)
    expect(appSettingsService.getSetting(db, secrets, appSettingsService.SIMPLEFIN_ACCESS_URL)).toBeNull()
  })

  it('test_build_provider_requires_connection', () => {
    expect(() => sync.buildProvider(db, secrets)).toThrow(sync.NotConnectedError)
    appSettingsService.setSetting(db, secrets, appSettingsService.SIMPLEFIN_ACCESS_URL, ACCESS_URL, { encrypt: true })
    expect(sync.buildProvider(db, secrets).name).toBe('simplefin')
  })

  it('test_stale_running_run_is_recovered', async () => {
    const stale = insertRun({ status: 'running', started_at: ago((sync.STALE_RUN_MINUTES + 5) * 60_000) })
    const result = await run(new FakeProvider(snap()))
    expect(result.status).toBe('success')
    const after = db.select().from(syncRuns).where(eq(syncRuns.id, stale.id)).get()
    expect(after?.status).toBe('error')
    expect(after?.finished_at).not.toBeNull()
    expect(after?.error_text).not.toBeNull()
    expect(after?.error_text?.startsWith('Interrupted')).toBe(true)
  })

  it('test_fresh_running_run_still_blocks', async () => {
    insertRun({ status: 'running', started_at: ago(60_000) })
    const attempt = run(new FakeProvider(snap()))
    await expect(attempt).rejects.toBeInstanceOf(ConflictError)
    await expect(attempt).rejects.toThrow(/already running/)
  })
})

describe('sync: what the port spells out', () => {
  it('runs transfers, categorization, and recurring detection after the upsert', async () => {
    await run(new SimpleFINProvider(ACCESS_URL, mockFetch()))
    const transfers = db.select({ n: count() }).from(transactions).where(eq(transactions.is_transfer, true)).get()?.n
    expect(transfers).toBeGreaterThan(0)
    expect(db.select({ n: count() }).from(categorizations).get()?.n).toBeGreaterThan(0)
    expect(db.select({ n: count() }).from(recurrences).get()?.n).toBeGreaterThan(0)
  })

  it('records the provider requests, one per 45-day chunk', async () => {
    const provider = new SimpleFINProvider(ACCESS_URL, mockFetch())
    const result = await run(provider)
    expect(result.requests).toBe(5) // 181 days, inclusive
    expect(sync.requestsUsedLast24h(db, new Date())).toBe(5)
  })

  it('a failed run still spends budget and keeps a DomainError detail as its text', async () => {
    const provider = {
      name: 'simplefin',
      requestsMade: 0,
      async fetch(): Promise<ProviderSnapshot> {
        this.requestsMade += 1
        throw new ProviderError('SimpleFIN returned HTTP 500.')
      },
    }
    const result = await run(provider)
    expect(result.status).toBe('error')
    expect(result.requests).toBe(1)
    expect(result.error_text).toBe('SimpleFIN returned HTTP 500.')
  })

  it("other errors read like Python's repr(exc), cut to 2000 characters", async () => {
    const fail = (message: string): BankProvider => ({
      name: 'simplefin',
      fetch: async () => {
        throw new TypeError(message)
      },
    })
    expect((await run(fail("it's bad"))).error_text).toBe(`TypeError("it's bad")`)
    const long = await run(fail('x'.repeat(3000)))
    expect(long.error_text).toHaveLength(2000)
    expect(long.error_text?.startsWith("TypeError('xxx")).toBe(true)
  })

  it('the window reads the real clock, not PLUTUS_TODAY', async () => {
    vi.stubEnv('PLUTUS_TODAY', '2020-01-15')
    vi.spyOn(sync.syncClock, 'now').mockReturnValue(new Date('2026-10-03T23:30:00.000Z'))
    const provider = new FakeProvider(snap())
    const result = await run(provider)
    expect(provider.windows[0]).toEqual([addDays('2026-10-03' as PlainDate, -180), '2026-10-03'])
    expect(result.started_at).toBe('2026-10-03T23:30:00.000Z')
  })

  it('a pending row without a transaction time keeps its first date', async () => {
    const pendingNoTime = (day: number): ProviderTransaction => ({ ...tx('P1', { pending: true, day }), transacted_at: null })
    const provider = new FakeProvider(snap([pendingNoTime(1)]), snap([pendingNoTime(2)]))
    await run(provider)
    const second = await run(provider)
    expect([second.added, second.updated]).toEqual([0, 0])
    expect(db.select().from(transactions).get()?.posted_on).toBe('2026-10-01')
  })

  it('updates account fields and reactivates an inactive account', async () => {
    const provider = new FakeProvider(snap(), { ...snap(), accounts: [{ ...snap().accounts[0]!, name: 'Main' }] })
    await run(provider)
    db.update(accounts).set({ is_active: false }).run()
    await run(provider)
    const account = db.select().from(accounts).get()
    expect(account?.name).toBe('Main')
    expect(account?.is_active).toBe(true)
    expect(rows(accounts)).toBe(1)
  })

  it('the stale-run sweep commits even when the guard then refuses', async () => {
    const stale = insertRun({ status: 'running', started_at: ago((sync.STALE_RUN_MINUTES + 1) * 60_000) })
    insertRun({ status: 'running', started_at: ago(60_000) })
    await expect(run(new FakeProvider(snap()))).rejects.toBeInstanceOf(ConflictError)
    expect(db.select().from(syncRuns).where(eq(syncRuns.id, stale.id)).get()?.status).toBe('error')
  })

  it('a refused run leaves no row behind', async () => {
    insertRun({ status: 'running', started_at: ago(60_000) })
    await expect(run(new FakeProvider(snap()))).rejects.toBeInstanceOf(ConflictError)
    expect(rows(syncRuns)).toBe(1)
  })

  it('lists runs newest first and finds one by id', async () => {
    const a = insertRun({ started_at: ago(3_600_000) })
    const b = insertRun({ started_at: ago(60_000) })
    const c = insertRun({ started_at: b.started_at })
    expect(sync.listRuns(db, 20).map((r) => r.id)).toEqual([c.id, b.id, a.id])
    expect(sync.listRuns(db, 1).map((r) => r.id)).toEqual([c.id])
    expect(sync.getRun(db, a.id).id).toBe(a.id)
    expect(() => sync.getRun(db, 999999)).toThrow('Sync run 999999 not found.')
  })
})

describe('sync: the manual run and its background half', () => {
  function connect(): void {
    appSettingsService.setSetting(db, secrets, appSettingsService.SIMPLEFIN_ACCESS_URL, ACCESS_URL, { encrypt: true })
  }

  it('startManualSync requires a connection and starts a manual simplefin run', () => {
    expect(() => sync.startManualSync(db, secrets, defaults)).toThrow(
      'SimpleFIN is not connected. Add a setup token first.',
    )
    connect()
    const started = sync.startManualSync(db, secrets, defaults)
    expect(started).toMatchObject({ provider: 'simplefin', trigger: 'manual', status: 'running' })
  })

  it('executeInBackground runs the started run to completion', async () => {
    connect()
    vi.stubGlobal('fetch', mockFetch())
    try {
      const started = sync.startManualSync(db, secrets, defaults)
      await sync.executeInBackground(db, secrets, defaults, started.id)
      expect(sync.getRun(db, started.id)).toMatchObject({ status: 'success', added: 295, requests: 5 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('executeInBackground fails the run when the provider cannot be built', async () => {
    connect()
    const started = sync.startManualSync(db, secrets, defaults)
    appSettingsService.deleteSetting(db, appSettingsService.SIMPLEFIN_ACCESS_URL)
    await sync.executeInBackground(db, secrets, defaults, started.id)
    expect(sync.getRun(db, started.id)).toMatchObject({
      status: 'error',
      error_text: 'SimpleFIN is not connected. Add a setup token in Settings.',
    })
  })

  it('executeInBackground ignores a missing run and never rejects', async () => {
    await expect(sync.executeInBackground(db, secrets, defaults, 999)).resolves.toBeUndefined()
    db.$client.close()
    await expect(sync.executeInBackground(db, secrets, defaults, 1, silentLogger())).resolves.toBeUndefined()
  })
})

describe('demo loader (app/demo.py)', () => {
  it('load syncs the fixture through the real pipeline under provider demo', async () => {
    expect(await demo.load(db, secrets, defaults)).toEqual(['demo sync success: added 295, updated 0'])
    expect(db.select().from(accounts).all().map((a) => a.provider)).toEqual(['demo', 'demo', 'demo'])
    expect(db.select().from(syncRuns).all()).toMatchObject([{ provider: 'demo', trigger: 'manual', status: 'success' }])
    expect(db.select({ n: count() }).from(categorizations).get()?.n).toBeGreaterThan(0)
    expect(await demo.load(db, secrets, defaults)).toEqual(['demo sync success: added 0, updated 0'])
  })

  it('load refuses like run_sync when a guard refuses', async () => {
    sync.startRun(db, secrets, defaults, 'simplefin', 'manual')
    await expect(demo.load(db, secrets, defaults)).rejects.toThrow(/already running/)
    db.update(syncRuns).set({ status: 'success' }).run()
    insertRun({ started_at: ago(60_000), requests: sync.DAILY_REQUEST_BUDGET })
    await expect(demo.load(db, secrets, defaults)).rejects.toThrow(/budget/)
  })

  it('clear removes demo accounts, their rows, demo runs, and orphaned classifications', async () => {
    await demo.load(db, secrets, defaults)
    const cached = db.select().from(merchantClassifications).all()
    expect(cached.length).toBeGreaterThan(1)
    const kept = cached[0]!
    const own = db.insert(accounts).values({ provider: 'simplefin', external_id: 'X', name: 'Mine' }).returning().get()
    db.insert(transactions)
      .values({
        account_id: own.id,
        external_id: 'T',
        posted_on: '2026-10-01' as PlainDate,
        amount: parseMoney('-1.00'),
        raw_description: 'X',
        merchant_key: kept.merchant_key,
      })
      .run()
    insertRun({ provider: 'simplefin', started_at: ago(60_000) })
    db.insert(rules).values({ match_type: 'exact', pattern: 'NETFLIX', category_id: kept.category_id }).run()

    expect(demo.clear(db)).toEqual([
      `removed 3 demo accounts, their transactions, and ${cached.length - 1} cached merchants`,
      'Rules you created are kept.',
    ])
    expect(db.select().from(accounts).all().map((a) => a.provider)).toEqual(['simplefin'])
    expect(rows(transactions)).toBe(1)
    expect(db.select().from(syncRuns).all().map((r) => r.provider)).toEqual(['simplefin'])
    expect(db.select().from(merchantClassifications).all().map((c) => c.merchant_key)).toEqual([kept.merchant_key])
    expect(db.select({ n: count() }).from(rules).get()?.n).toBe(1)
  })

  it('main prints the usage and fails without a known command', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((text: string) => void errors.push(text))
    expect(await demo.main(['nope'])).toBe(1)
    expect(await demo.main([])).toBe(1)
    expect(await demo.main(['load', 'extra'])).toBe(1)
    expect(errors[0]).toContain('npm run demo -- load')
  })

  it('reads the fixture the tests use', () => {
    expect(demo.FIXTURE.endsWith('test/fixtures/simplefin_accounts.json')).toBe(true)
  })
})
