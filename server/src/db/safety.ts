/**
 * The safety steps around migrations in openDb: the schema guard (an app older than its data
 * refuses it), the pre-migration backup (VACUUM INTO, verified, newest 5 kept), the checks
 * after migrating, and restoring the backup when they fail.
 *
 * VACUUM INTO rather than better-sqlite3's backup(): it is synchronous, so openDb stays sync,
 * and it copies a consistent snapshot through the open connection, which includes committed
 * rows still in the -wal file. backup() returns a Promise.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  copyFileSync,
  statSync,
  statfsSync,
} from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { utcNow } from '../lib/dates.js'

export const KEEP_BACKUPS = 5
export const LAST_APP_VERSION_KEY = 'last_app_version'

/** The server package version, recorded as the version that last opened the database. */
export const APP_VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version

/** Room for the copy and the migration's own writes, on top of twice the database size. */
const SPACE_MARGIN_BYTES = 16 * 1024 * 1024
const BACKUP_FILE = /^plutus-.+-before-.+\.sqlite$/
const UNCHANGED = 'Your data has not been changed.'

export type DatabaseOpenErrorKind = 'too_new' | 'backup_failed' | 'migration_failed' | 'restored'

/** openDb refused or undid an update. The message is plain enough to show the owner. */
export class DatabaseOpenError extends Error {
  readonly kind: DatabaseOpenErrorKind
  /** The pre-migration backup, when one was written. */
  readonly backupPath: string | null

  constructor(
    kind: DatabaseOpenErrorKind,
    message: string,
    options: { backupPath?: string | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DatabaseOpenError'
    this.kind = kind
    this.backupPath = options.backupPath ?? null
  }
}

export interface JournalEntry {
  tag: string
  when: number
}

/** The migrations bundled with the app, oldest first (drizzle-kit's meta/_journal.json). */
export function bundledMigrations(migrationsFolder: string): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[]
  }
  return journal.entries.map(({ tag, when }) => ({ tag, when }))
}

function hasTable(client: Database.Database, name: string): boolean {
  return client.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

/** The created_at of the newest applied migration, as drizzle compares it; null if none. */
export function newestApplied(client: Database.Database): number | null {
  if (!hasTable(client, '__drizzle_migrations')) return null
  const value = client.prepare('SELECT max(created_at) FROM __drizzle_migrations').pluck().get()
  return value === null || value === undefined ? null : Number(value)
}

/** The bundled migrations drizzle will apply: newer than the newest applied one. */
export function pendingMigrations(client: Database.Database, bundled: JournalEntry[]): JournalEntry[] {
  const applied = newestApplied(client)
  return applied === null ? bundled : bundled.filter((m) => m.when > applied)
}

export function lastAppVersion(client: Database.Database): string | null {
  if (!hasTable(client, 'app_settings')) return null
  const value = client.prepare('SELECT value FROM app_settings WHERE key = ?').pluck().get(LAST_APP_VERSION_KEY)
  return typeof value === 'string' ? value : null
}

export function recordAppVersion(client: Database.Database, version = APP_VERSION): void {
  client
    .prepare(
      `INSERT INTO app_settings (key, value, is_encrypted) VALUES (?, ?, 0)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE value <> excluded.value`,
    )
    .run(LAST_APP_VERSION_KEY, version)
}

/** Throws when the database has a migration newer than any this app bundles. */
export function guardSchema(client: Database.Database, bundled: JournalEntry[]): void {
  const applied = newestApplied(client)
  const newest = bundled.at(-1)?.when ?? 0
  if (applied === null || applied <= newest) return
  const last = lastAppVersion(client)
  const install = last && last !== APP_VERSION ? `Plutus ${last} or later` : 'the newer version'
  const by = last && last !== APP_VERSION ? `Plutus ${last}, ` : ''
  throw new DatabaseOpenError(
    'too_new',
    `This data was last opened by ${by}a newer version of Plutus than this one (${APP_VERSION}). ` +
      `Install ${install} to open it. ${UNCHANGED}`,
  )
}

/** True once the database has any table, i.e. there is something a migration could lose. */
export function hasData(client: Database.Database): boolean {
  return client.prepare("SELECT count(*) FROM sqlite_master WHERE type = 'table'").pluck().get() !== 0
}

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

function mb(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`
}

function stamp(): string {
  return utcNow().replace(/[:.]/g, '-')
}

/** One integrity_check result: 'ok', or the problems it found. */
function integrity(client: Database.Database): string {
  const rows = client.pragma('integrity_check', { simple: false }) as { integrity_check: string }[]
  return rows.map((r) => r.integrity_check).join('; ')
}

/**
 * Write a verified copy of the open database to `<backupDir>/plutus-<UTC>-before-<tag>.sqlite`
 * and keep the newest KEEP_BACKUPS. Throws a 'backup_failed' DatabaseOpenError, before any
 * change to the database, when space is short or the copy fails or does not verify.
 */
export function backupBeforeMigrating(
  client: Database.Database,
  dbPath: string,
  backupDir: string,
  nextTag: string,
): string {
  const fail = (reason: string, cause?: unknown): never => {
    throw new DatabaseOpenError(
      'backup_failed',
      `Plutus could not back up your data before updating it, so it did not update it: ${reason}. ${UNCHANGED}`,
      { cause },
    )
  }
  try {
    mkdirSync(backupDir, { recursive: true })
  } catch (err) {
    fail(`cannot create the backup folder ${backupDir} (${String(err)})`, err)
  }
  const needed = 2 * (sizeOf(dbPath) + sizeOf(`${dbPath}-wal`)) + SPACE_MARGIN_BYTES
  let free: number
  try {
    const fs = statfsSync(backupDir)
    free = Number(fs.bavail) * Number(fs.bsize)
  } catch (err) {
    return fail(`cannot read the free disk space in ${backupDir} (${String(err)})`, err)
  }
  if (free < needed) {
    fail(`not enough free disk space (${mb(needed)} needed, ${mb(free)} free). Free up some space and open Plutus again`)
  }

  const target = join(backupDir, `plutus-${stamp()}-before-${nextTag}.sqlite`)
  try {
    client.prepare('VACUUM INTO ?').run(target)
  } catch (err) {
    rmSync(target, { force: true })
    fail(`writing ${target} failed (${String(err)})`, err)
  }
  let result: string
  try {
    const copy = new Database(target, { readonly: true, fileMustExist: true })
    try {
      result = integrity(copy)
    } finally {
      copy.close()
    }
  } catch (err) {
    result = String(err)
  }
  if (result !== 'ok') {
    rmSync(target, { force: true })
    fail(`the backup did not verify (${result})`)
  }
  pruneBackups(backupDir)
  return target
}

/** Delete all but the newest KEEP_BACKUPS pre-migration backups; other files stay. */
export function pruneBackups(backupDir: string, keep = KEEP_BACKUPS): void {
  const files = readdirSync(backupDir)
    .filter((f) => BACKUP_FILE.test(f))
    .sort()
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(backupDir, f), { force: true })
}

/** Problems after migrating: integrity_check and foreign_key_check; empty when clean. */
export function postMigrationProblems(client: Database.Database): string[] {
  const problems: string[] = []
  const result = integrity(client)
  if (result !== 'ok') problems.push(`integrity check: ${result}`)
  const violations = client.pragma('foreign_key_check') as { table: string; rowid: number; parent: string }[]
  if (violations.length > 0) {
    const sample = violations
      .slice(0, 5)
      .map((v) => `${v.table} row ${v.rowid} -> ${v.parent}`)
      .join(', ')
    problems.push(`${violations.length} foreign key violation(s): ${sample}`)
  }
  return problems
}

/**
 * Put the backup back over the database (the client must be closed). The rejected database
 * and its -wal and -shm files move to `<backupDir>/failed-<UTC>.sqlite*`, never deleted.
 */
export function restoreBackup(dbPath: string, backupPath: string, backupDir: string): string {
  const failed = join(backupDir, `failed-${stamp()}.sqlite`)
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, failed + suffix)
  }
  copyFileSync(backupPath, dbPath)
  return failed
}
