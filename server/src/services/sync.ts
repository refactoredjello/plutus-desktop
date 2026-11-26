/**
 * SimpleFIN sync. One run = one pass over the provider; never retried within a run.
 * Also the background half of the manual run and the run queries (routes stay thin).
 *
 * - A transaction cannot stay open across an await (the LLM call in categorization), so a
 *   run commits per step: the upsert with transfer matching, then categorization (which
 *   commits its own batches), then recurring detection with the run's outcome. A failure rolls back its own step only; earlier steps stay committed.
 * - startRun's prune, guards, and insert commit together; a refused run rolls the prune back.
 * - The clock is the real UTC clock; `syncClock` lets tests pin it.
 *   Services downstream (recurring detection) read lib/dates.today() themselves.
 */

import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import type { RuntimeDefaults } from '../config.js'
import type { Db } from '../db/index.js'
import { type SyncTrigger, accounts, balanceSnapshots, syncRuns, transactions } from '../db/schema.js'
import type { PlainDate } from '../lib/dates.js'
import { ConflictError, DomainError, NotFoundError } from '../lib/errors.js'
import { type Logger, silentLogger } from '../lib/log.js'
import { type FetchFn, PROVIDER_NAME, SimpleFINProvider, chunkRanges } from '../providers/bank/simplefin.js'
import type { BankProvider, ProviderAccount, ProviderTransaction } from '../providers/bank/types.js'
import type { SecretStore } from '../secrets.js'
import { SIMPLEFIN_ACCESS_URL, getSetting } from './app_settings.js'
import { categorizePending } from './categorize.js'
import { pruneDismissals } from './changes.js'
import { runtimeConfig } from './config.js'
import { detectRecurring } from './recurring.js'
import { matchTransfers } from './transfers.js'

export const OVERLAP_DAYS = 5
export const STALE_RUN_MINUTES = 30
export const DAILY_REQUEST_BUDGET = 24 // SimpleFIN: 24 requests per day

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const ERROR_TEXT_MAX = 2000

export type SyncRun = typeof syncRuns.$inferSelect
type Account = typeof accounts.$inferSelect
type Transaction = typeof transactions.$inferSelect

export class NotConnectedError extends DomainError {
  override readonly title = 'SimpleFIN not connected'
}

/** datetime.now(UTC), swappable in tests. */
export const syncClock = { now: (): Date => new Date() }

/** The UTC date of an instant in milliseconds. */
function utcDate(ms: number): PlainDate {
  return new Date(ms).toISOString().slice(0, 10) as PlainDate
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** A string quoted and escaped for the error text of a non-domain exception. */
function reprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'"
  let out = ''
  for (const ch of text) {
    if (ch === quote || ch === '\\') out += `\\${ch}`
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else out += ch
  }
  return `${quote}${out}${quote}`
}

/** repr(exc): `Name('message')`, or `Name()` without one. */
function reprError(err: unknown): string {
  if (err instanceof Error) return err.message ? `${err.name}(${reprString(err.message)})` : `${err.name}()`
  return String(err)
}

/** str(exc). */
function strError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function isConnected(db: Db, secrets: SecretStore): boolean {
  return getSetting(db, secrets, SIMPLEFIN_ACCESS_URL) !== null
}

/** Build the SimpleFIN provider from the stored (encrypted) access URL. */
export function buildProvider(db: Db, secrets: SecretStore, fetchFn?: FetchFn): BankProvider {
  const accessUrl = getSetting(db, secrets, SIMPLEFIN_ACCESS_URL)
  if (accessUrl === null) {
    throw new NotConnectedError('SimpleFIN is not connected. Add a setup token in Settings.')
  }
  return new SimpleFINProvider(accessUrl, fetchFn)
}

/** A run left `running` by a crash or restart would block every future sync. */
function recoverStaleRuns(db: Db, log: Logger): void {
  const now = syncClock.now().getTime()
  db.transaction(() => {
    const stale = db
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.status, 'running'), lt(syncRuns.started_at, iso(now - STALE_RUN_MINUTES * MINUTE_MS))))
      .all()
    for (const run of stale) {
      db.update(syncRuns)
        .set({
          status: 'error',
          error_text: 'Interrupted: the sync did not finish (the server may have restarted).',
          finished_at: iso(now),
        })
        .where(eq(syncRuns.id, run.id))
        .run()
      log.warn({ run_id: run.id }, 'sync_run_recovered')
    }
  })
}

export function requestsUsedLast24h(db: Db, now: Date): number {
  const used = db
    .select({ used: sql<number>`coalesce(sum(${syncRuns.requests}), 0)` })
    .from(syncRuns)
    .where(gte(syncRuns.started_at, iso(now.getTime() - DAY_MS)))
    .get()?.used
  return Number(used ?? 0)
}

/** Apply the guards and commit a new `running` row. */
export function startRun(
  db: Db,
  secrets: SecretStore,
  defaults: RuntimeDefaults,
  providerName: string,
  trigger: SyncTrigger,
  log: Logger = silentLogger(),
): SyncRun {
  recoverStaleRuns(db, log)
  const { syncFirstHistoryDays } = runtimeConfig(db, secrets, defaults)
  return db.transaction(() => {
    pruneDismissals(db) // housekeeping at the start of each run
    const running = db.select({ id: syncRuns.id }).from(syncRuns).where(eq(syncRuns.status, 'running')).limit(1).get()
    if (running !== undefined) throw new ConflictError('A sync is already running.')
    const now = syncClock.now()
    const used = requestsUsedLast24h(db, now)
    const planned = chunkRanges(...window(db, now, syncFirstHistoryDays)).length
    if (used + planned > DAILY_REQUEST_BUDGET) {
      throw new ConflictError(
        `SimpleFIN daily request budget reached: ${used} of ${DAILY_REQUEST_BUDGET} used in the ` +
          `last 24 hours and this sync needs ${planned}. Try again later.`,
      )
    }
    return db
      .insert(syncRuns)
      .values({ provider: providerName, trigger, status: 'running', started_at: now.toISOString() })
      .returning()
      .get()
  })
}

function window(db: Db, now: Date, firstHistoryDays: number): [PlainDate, PlainDate] {
  const last = db
    .select({ started_at: syncRuns.started_at })
    .from(syncRuns)
    .where(eq(syncRuns.status, 'success'))
    .orderBy(desc(syncRuns.started_at))
    .limit(1)
    .get()?.started_at
  const start =
    last !== undefined ? Date.parse(last) - OVERLAP_DAYS * DAY_MS : now.getTime() - firstHistoryDays * DAY_MS
  return [utcDate(start), utcDate(now.getTime())]
}

function upsertAccount(db: Db, providerName: string, pa: ProviderAccount): Account {
  const values = {
    name: pa.name,
    type: pa.type,
    institution_name: pa.institution_name,
    currency: pa.currency,
    is_active: true,
  }
  const account = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.provider, providerName), eq(accounts.external_id, pa.external_id)))
    .get()
  if (account === undefined) {
    return db
      .insert(accounts)
      .values({ provider: providerName, external_id: pa.external_id, ...values })
      .returning()
      .get()
  }
  // Write only changed columns, so an unchanged account keeps updated_at.
  const changed = Object.fromEntries(
    Object.entries(values).filter(([key, value]) => account[key as keyof typeof values] !== value),
  )
  if (Object.keys(changed).length === 0) return account
  return db.update(accounts).set(changed).where(eq(accounts.id, account.id)).returning().get() as Account
}

type Applied = Pick<Transaction, 'transacted_at' | 'amount' | 'raw_description' | 'payee' | 'memo' | 'pending' | 'posted_on'>

/** _apply: the provider fields that differ from a stored row (all of them for a new row). */
function changes(tx: Transaction | undefined, pt: ProviderTransaction): Partial<Applied> {
  const values: Partial<Applied> = {
    transacted_at: pt.transacted_at,
    amount: pt.amount,
    raw_description: pt.description,
    payee: pt.payee,
    memo: pt.memo,
    pending: pt.pending,
  }
  // A pending row without a transaction time has a made-up date; do not churn it every sync.
  if (!(tx?.pending && pt.pending && pt.transacted_at === null)) values.posted_on = pt.posted_on
  if (tx === undefined) return values
  return Object.fromEntries(
    Object.entries(values).filter(([key, value]) => tx[key as keyof Applied] !== value),
  ) as Partial<Applied>
}

/**
 * Insert new rows and update changed ones; returns [added, updated]. `fresh` collects the ids
 * of new and newly posted rows, the only rows transfer matching may pair.
 */
function upsertTransactions(
  db: Db,
  account: Account,
  txs: readonly ProviderTransaction[],
  fresh: Set<number>,
): [number, number] {
  if (txs.length === 0) return [0, 0]
  // Read the account's rows and look ids up, rather than `external_id IN (ids)`, to stay clear
  // of SQLite's bound-parameter limit.
  const ids = new Set(txs.map((t) => t.external_id))
  const existing = new Map(
    db
      .select()
      .from(transactions)
      .where(eq(transactions.account_id, account.id))
      .all()
      .filter((t) => ids.has(t.external_id))
      .map((t) => [t.external_id, t]),
  )
  let added = 0
  let updated = 0
  for (const pt of txs) {
    const tx = existing.get(pt.external_id)
    if (tx === undefined) {
      const values = changes(undefined, pt) as Applied
      const row = db
        .insert(transactions)
        .values({ account_id: account.id, external_id: pt.external_id, ...values, posted_on: pt.posted_on })
        .returning({ id: transactions.id })
        .get()
      fresh.add(row.id)
      added += 1
      continue
    }
    const changed = changes(tx, pt)
    if (Object.keys(changed).length > 0) {
      db.update(transactions).set(changed).where(eq(transactions.id, tx.id)).run()
      if (changed.pending === false) fresh.add(tx.id)
      updated += 1
    }
  }
  return [added, updated]
}

/** A pending row that was not returned again either posted under a new id or was dropped. */
function dropStalePending(db: Db, account: Account, start: PlainDate, seen: ReadonlySet<string>): void {
  // Delete the candidates whose external_id is not in `seen` (all of them when seen is empty);
  // filtering here rather than with NOT IN avoids SQLite's bound-parameter limit.
  const stale = db
    .select({ id: transactions.id, external_id: transactions.external_id })
    .from(transactions)
    .where(
      and(eq(transactions.account_id, account.id), eq(transactions.pending, true), gte(transactions.posted_on, start)),
    )
    .all()
    .filter((t) => !seen.has(t.external_id))
  for (const t of stale) db.delete(transactions).where(eq(transactions.id, t.id)).run()
}

function loadRun(db: Db, runId: number): SyncRun | undefined {
  return db.select().from(syncRuns).where(eq(syncRuns.id, runId)).get()
}

/** Run the sync for an existing `running` row, then record the outcome. */
export async function executeRun(
  db: Db,
  secrets: SecretStore,
  defaults: RuntimeDefaults,
  provider: BankProvider,
  run: SyncRun,
  log: Logger = silentLogger(),
): Promise<SyncRun> {
  const runId = run.id
  try {
    const { syncFirstHistoryDays } = runtimeConfig(db, secrets, defaults)
    const [start, end] = window(db, new Date(run.started_at), syncFirstHistoryDays)
    const snapshot = await provider.fetch(start, end)
    let added = 0
    let updated = 0
    const fresh = new Set<number>()
    db.transaction(() => {
      for (const pa of snapshot.accounts) {
        const account = upsertAccount(db, provider.name, pa)
        db.insert(balanceSnapshots)
          .values({ account_id: account.id, balance: pa.balance, available: pa.available, as_of: pa.balance_as_of })
          .run()
        const [a, u] = upsertTransactions(db, account, pa.transactions, fresh)
        added += a
        updated += u
        if (snapshot.errors.length === 0) {
          // partial data must not delete rows we simply did not see
          dropStalePending(db, account, start, new Set(pa.transactions.map((t) => t.external_id)))
        }
      }
      matchTransfers(db, fresh)
    })
    await categorizePending(db, secrets, defaults, null, log)
    return db.transaction(() => {
      detectRecurring(db)
      const outcome = {
        added,
        requests: provider.requestsMade ?? 0,
        updated,
        status: snapshot.errors.length > 0 ? ('error' as const) : ('success' as const),
        ...(snapshot.errors.length > 0 ? { error_text: snapshot.errors.join('; ') } : {}),
        finished_at: syncClock.now().toISOString(),
      }
      db.update(syncRuns).set(outcome).where(eq(syncRuns.id, runId)).run()
      return loadRun(db, runId) ?? { ...run, ...outcome }
    })
  } catch (err) {
    log.error({ err, run_id: runId }, 'sync_run_failed')
    const failed = loadRun(db, runId) ?? run
    // failed runs still spend budget
    const withRequests = { ...failed, requests: provider.requestsMade ?? 0 }
    return failRun(db, withRequests, err instanceof DomainError ? err.detail : reprError(err))
  }
}

/** Record a run as failed, with the run's request count. */
export function failRun(db: Db, run: SyncRun, message: string): SyncRun {
  const outcome = {
    status: 'error' as const,
    error_text: Array.from(message).slice(0, ERROR_TEXT_MAX).join(''),
    finished_at: syncClock.now().toISOString(),
    requests: run.requests,
  }
  db.update(syncRuns).set(outcome).where(eq(syncRuns.id, run.id)).run()
  return loadRun(db, run.id) ?? { ...run, ...outcome }
}

export async function runSync(
  db: Db,
  secrets: SecretStore,
  defaults: RuntimeDefaults,
  provider: BankProvider,
  trigger: SyncTrigger,
  log: Logger = silentLogger(),
): Promise<SyncRun> {
  const run = startRun(db, secrets, defaults, provider.name, trigger, log)
  return executeRun(db, secrets, defaults, provider, run, log)
}

/** POST /api/sync before it answers: require a connection, then start a manual run. */
export function startManualSync(
  db: Db,
  secrets: SecretStore,
  defaults: RuntimeDefaults,
  log: Logger = silentLogger(),
): SyncRun {
  if (!isConnected(db, secrets)) {
    throw new NotConnectedError('SimpleFIN is not connected. Add a setup token first.')
  }
  return startRun(db, secrets, defaults, PROVIDER_NAME, 'manual', log)
}

/**
 * The run POST /api/sync starts after it answers. Never rejects: a
 * detached promise must record its own failure, not surface as an unhandled rejection.
 */
export async function executeInBackground(
  db: Db,
  secrets: SecretStore,
  defaults: RuntimeDefaults,
  runId: number,
  log: Logger = silentLogger(),
): Promise<void> {
  try {
    const run = loadRun(db, runId)
    if (run === undefined) return
    let provider: BankProvider
    try {
      provider = buildProvider(db, secrets)
    } catch (err) {
      failRun(db, run, strError(err))
      return
    }
    await executeRun(db, secrets, defaults, provider, run, log)
  } catch (err) {
    log.error({ err, run_id: runId }, 'sync_background_crashed')
  }
}

/** GET /api/sync/runs: newest first. */
export function listRuns(db: Db, limit: number): SyncRun[] {
  return db.select().from(syncRuns).orderBy(desc(syncRuns.started_at), desc(syncRuns.id)).limit(limit).all()
}

export function getRun(db: Db, runId: number): SyncRun {
  const run = loadRun(db, runId)
  if (run === undefined) throw new NotFoundError(`Sync run ${runId} not found.`)
  return run
}
