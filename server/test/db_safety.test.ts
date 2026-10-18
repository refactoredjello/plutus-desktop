/**
 * Safe database updates in openDb: migrations run with foreign keys off (a table rebuild keeps
 * child rows), a verified backup comes first when there is data to lose, a failed check after
 * migrating restores it, and an app older than its data refuses to open it.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  APP_VERSION,
  DatabaseOpenError,
  KEEP_BACKUPS,
  LAST_APP_VERSION_KEY,
  MIGRATIONS_FOLDER,
  openDb,
} from '../src/db/index.js'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plutus-db-safety-'))
  dbPath = join(dir, 'data', 'plutus.sqlite')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface Extra {
  tag: string
  sql: string
}

/** A copy of the bundled migrations plus `extra` ones, each newer than the last. */
function migrationsWith(name: string, extra: Extra[] = []): string {
  const folder = join(dir, `migrations-${name}`)
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true })
  const journalPath = join(folder, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[]
  }
  let when = journal.entries.at(-1)?.when ?? 0
  for (const m of extra) {
    when += 60_000
    journal.entries.push({ idx: journal.entries.length, version: '6', when, tag: m.tag, breakpoints: true })
    writeFileSync(join(folder, `${m.tag}.sql`), m.sql)
  }
  writeFileSync(journalPath, JSON.stringify(journal, null, 2))
  return folder
}

const ACCOUNT_COLUMNS =
  '"id", "provider", "external_id", "name", "type", "institution_name", "currency", "is_active", "created_at", "updated_at"'

/** What drizzle-kit writes when it can't ALTER a table: copy to __new_x, drop, rename. */
const REBUILD_ACCOUNTS = [
  'PRAGMA foreign_keys=OFF;',
  `CREATE TABLE \`__new_accounts\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`provider\` text NOT NULL,
	\`external_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`type\` text NOT NULL,
	\`institution_name\` text,
	\`currency\` text NOT NULL,
	\`is_active\` integer NOT NULL,
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`nickname\` text
);`,
  `INSERT INTO \`__new_accounts\`(${ACCOUNT_COLUMNS}) SELECT ${ACCOUNT_COLUMNS} FROM \`accounts\`;`,
  'DROP TABLE `accounts`;',
  'ALTER TABLE `__new_accounts` RENAME TO `accounts`;',
  'PRAGMA foreign_keys=ON;',
  'CREATE UNIQUE INDEX `uq_accounts_provider` ON `accounts` (`provider`,`external_id`);',
].join('--> statement-breakpoint\n')

/** Leaves a balance snapshot whose account does not exist. */
const ORPHAN_ROW =
  "INSERT INTO `balance_snapshots` (`account_id`, `balance`, `as_of`) VALUES (999, 100, '2026-01-01T00:00:00.000Z');"

const ADD_MARKER = 'CREATE TABLE `marker` (`id` integer PRIMARY KEY);'

/** A database at the bundled schema with one account, two transactions, and a balance. */
function seedDatabase(path = dbPath): void {
  const db = openDb(path, { migrationsFolder: migrationsWith('base') })
  const c = db.$client
  c.prepare(
    "INSERT INTO accounts (provider, external_id, name, type, currency, is_active) VALUES ('test', 'A1', 'Checking', 'checking', 'USD', 1)",
  ).run()
  const tx = c.prepare(
    "INSERT INTO transactions (account_id, external_id, posted_on, amount, raw_description, pending, is_transfer) VALUES (1, ?, '2026-01-10', -1250, 'COFFEE', 0, 0)",
  )
  tx.run('T1')
  tx.run('T2')
  c.prepare("INSERT INTO balance_snapshots (account_id, balance, as_of) VALUES (1, 50000, '2026-01-10T00:00:00.000Z')").run()
  c.close()
}

function count(path: string, table: string): number {
  const c = new Database(path, { readonly: true })
  try {
    return c.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number
  } finally {
    c.close()
  }
}

function appliedMigrations(path: string): number {
  return count(path, '__drizzle_migrations')
}

function tableExists(path: string, table: string): boolean {
  const c = new Database(path, { readonly: true })
  try {
    return c.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined
  } finally {
    c.close()
  }
}

function backups(backupDir = join(dir, 'data', 'backups')): string[] {
  if (!existsSync(backupDir)) return []
  return readdirSync(backupDir)
    .filter((f) => /^plutus-.+-before-.+\.sqlite$/.test(f))
    .sort()
}

function openError(fn: () => unknown): DatabaseOpenError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(DatabaseOpenError)
    return err as DatabaseOpenError
  }
  throw new Error('expected openDb to throw')
}

describe('migrations run with foreign keys off', () => {
  it('keeps child rows when a migration rebuilds their parent table', () => {
    seedDatabase()
    const folder = migrationsWith('rebuild', [{ tag: '0001_rebuild_accounts', sql: REBUILD_ACCOUNTS }])
    const db = openDb(dbPath, { migrationsFolder: folder })
    const c = db.$client
    expect(c.prepare('SELECT count(*) FROM transactions').pluck().get()).toBe(2)
    expect(c.prepare('SELECT count(*) FROM balance_snapshots').pluck().get()).toBe(1)
    expect(c.prepare('SELECT nickname FROM accounts WHERE id = 1').pluck().get()).toBeNull()
    c.close()
  })

  it('turns foreign keys on once the database is open', () => {
    seedDatabase()
    const db = openDb(dbPath, { migrationsFolder: migrationsWith('fk', [{ tag: '0001_marker', sql: ADD_MARKER }]) })
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(() =>
      db.$client
        .prepare("INSERT INTO balance_snapshots (account_id, balance, as_of) VALUES (999, 1, '2026-01-01T00:00:00.000Z')")
        .run(),
    ).toThrow(/FOREIGN KEY/)
    db.$client.close()
    expect(openDb(':memory:').$client.pragma('foreign_keys', { simple: true })).toBe(1)
  })
})

describe('pre-migration backup', () => {
  it('writes a verified copy named for the next migration before migrating', () => {
    seedDatabase()
    const folder = migrationsWith('next', [
      { tag: '0001_marker', sql: ADD_MARKER },
      { tag: '0002_more', sql: 'CREATE TABLE `more` (`id` integer PRIMARY KEY);' },
    ])
    openDb(dbPath, { migrationsFolder: folder }).$client.close()

    const files = backups()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^plutus-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-before-0001_marker\.sqlite$/)
    const backup = join(dir, 'data', 'backups', files[0] ?? '')
    const c = new Database(backup, { readonly: true })
    expect(c.pragma('integrity_check', { simple: true })).toBe('ok')
    c.close()
    expect(count(backup, 'transactions')).toBe(2)
    expect(appliedMigrations(backup)).toBe(1)
    expect(tableExists(backup, 'marker')).toBe(false)
    expect(tableExists(dbPath, 'more')).toBe(true)
  })

  it('makes no backup for a new database or when nothing is pending', () => {
    const folder = migrationsWith('base')
    openDb(dbPath, { migrationsFolder: folder }).$client.close()
    openDb(dbPath, { migrationsFolder: folder }).$client.close()
    expect(backups()).toEqual([])
  })

  it('makes no backup for an in-memory database', () => {
    expect(() => openDb(':memory:').$client.close()).not.toThrow()
  })

  it('writes to the backup folder it is given', () => {
    seedDatabase()
    const backupDir = join(dir, 'elsewhere')
    const folder = migrationsWith('next', [{ tag: '0001_marker', sql: ADD_MARKER }])
    openDb(dbPath, { migrationsFolder: folder, backupDir }).$client.close()
    expect(backups(backupDir)).toHaveLength(1)
    expect(backups()).toEqual([])
  })

  it('includes rows that are still only in the WAL file', () => {
    seedDatabase()
    const writer = new Database(dbPath)
    writer.pragma('journal_mode = WAL')
    writer.pragma('wal_autocheckpoint = 0')
    const insert = writer.prepare(
      "INSERT INTO transactions (account_id, external_id, posted_on, amount, raw_description, pending, is_transfer) VALUES (1, ?, '2026-02-01', -500, 'LUNCH', 0, 0)",
    )
    for (let i = 0; i < 20; i++) insert.run(`W${i}`)
    // A plain copy of the main file misses them: they live in plutus.sqlite-wal.
    const plain = join(dir, 'plain-copy.sqlite')
    copyFileSync(dbPath, plain)
    expect(count(plain, 'transactions')).toBe(2)

    const folder = migrationsWith('next', [{ tag: '0001_marker', sql: ADD_MARKER }])
    openDb(dbPath, { migrationsFolder: folder }).$client.close()
    writer.close()
    const [file] = backups()
    expect(count(join(dir, 'data', 'backups', file ?? ''), 'transactions')).toBe(22)
  })

  it(`keeps the newest ${KEEP_BACKUPS} backups and leaves other files alone`, () => {
    seedDatabase()
    const backupDir = join(dir, 'data', 'backups')
    mkdirSync(backupDir, { recursive: true })
    const old = [1, 2, 3, 4, 5, 6].map((d) => `plutus-2020-01-0${d}T00-00-00-000Z-before-0000_old.sqlite`)
    for (const f of old) writeFileSync(join(backupDir, f), 'old')
    writeFileSync(join(backupDir, 'notes.txt'), 'keep me')

    openDb(dbPath, { migrationsFolder: migrationsWith('next', [{ tag: '0001_marker', sql: ADD_MARKER }]) }).$client.close()

    const files = backups()
    expect(files).toHaveLength(KEEP_BACKUPS)
    expect(files.slice(0, 4)).toEqual(old.slice(2))
    expect(files[4]).toMatch(/-before-0001_marker\.sqlite$/)
    expect(existsSync(join(backupDir, 'notes.txt'))).toBe(true)
  })

  it('does not migrate when the backup cannot be written', () => {
    seedDatabase()
    const backupDir = join(dir, 'not-a-folder')
    writeFileSync(backupDir, 'a file where the backup folder should be')
    const folder = migrationsWith('next', [{ tag: '0001_marker', sql: ADD_MARKER }])
    const err = openError(() => openDb(dbPath, { migrationsFolder: folder, backupDir }))
    expect(err.kind).toBe('backup_failed')
    expect(err.message).toMatch(/not been changed/)
    expect(appliedMigrations(dbPath)).toBe(1)
    expect(tableExists(dbPath, 'marker')).toBe(false)
  })
})

describe('checks after migrating', () => {
  it('restores the backup when the migration leaves a foreign key violation', () => {
    seedDatabase()
    const folder = migrationsWith('orphan', [{ tag: '0001_orphan', sql: ORPHAN_ROW }])
    const err = openError(() => openDb(dbPath, { migrationsFolder: folder }))
    expect(err.kind).toBe('restored')
    const [file] = backups()
    const backup = join(dir, 'data', 'backups', file ?? '')
    expect(err.backupPath).toBe(backup)
    expect(err.message).toContain(backup)
    expect(err.message).toMatch(/restored/)

    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(existsSync(`${dbPath}-shm`)).toBe(false)
    expect(appliedMigrations(dbPath)).toBe(1)
    expect(count(dbPath, 'balance_snapshots')).toBe(1)
    expect(count(dbPath, 'transactions')).toBe(2)
    // The rejected database is set aside, not deleted.
    expect(readdirSync(join(dir, 'data', 'backups')).some((f) => f.startsWith('failed-'))).toBe(true)
  })

  it('reports a failed migration as nothing changed', () => {
    seedDatabase()
    const folder = migrationsWith('broken', [
      { tag: '0001_broken', sql: `${ADD_MARKER}--> statement-breakpoint\nINSERT INTO no_such_table VALUES (1);` },
    ])
    const err = openError(() => openDb(dbPath, { migrationsFolder: folder }))
    expect(err.kind).toBe('migration_failed')
    expect(err.message).toMatch(/not been changed/)
    expect(appliedMigrations(dbPath)).toBe(1)
    expect(tableExists(dbPath, 'marker')).toBe(false)
    expect(count(dbPath, 'transactions')).toBe(2)
  })
})

describe('schema guard', () => {
  it('refuses a database migrated by a newer app, without touching it', () => {
    const newer = migrationsWith('newer', [{ tag: '0001_marker', sql: ADD_MARKER }])
    const db = openDb(dbPath, { migrationsFolder: newer })
    db.$client.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('9.9.9', LAST_APP_VERSION_KEY)
    db.$client.close()
    const before = readFileSync(dbPath)

    const err = openError(() => openDb(dbPath, { migrationsFolder: migrationsWith('base') }))
    expect(err.kind).toBe('too_new')
    expect(err.message).toContain('9.9.9')
    expect(err.message).toMatch(/newer version of Plutus/)
    expect(err.message).toMatch(/not been changed/)
    expect(readFileSync(dbPath).equals(before)).toBe(true)
    expect(appliedMigrations(dbPath)).toBe(2)
    expect(backups()).toEqual([])
  })

  it('records the app version that last opened the database', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(APP_VERSION).toBe(pkg.version)
    openDb(dbPath).$client.close()
    const c = new Database(dbPath, { readonly: true })
    expect(c.prepare('SELECT value, is_encrypted FROM app_settings WHERE key = ?').get(LAST_APP_VERSION_KEY)).toEqual({
      value: APP_VERSION,
      is_encrypted: 0,
    })
    c.close()
  })

  it('records and names the app version it is given', () => {
    const newer = migrationsWith('newer', [{ tag: '0001_marker', sql: ADD_MARKER }])
    openDb(dbPath, { migrationsFolder: newer, appVersion: '0.3.0' }).$client.close()
    const c = new Database(dbPath, { readonly: true })
    expect(c.prepare('SELECT value FROM app_settings WHERE key = ?').pluck().get(LAST_APP_VERSION_KEY)).toBe('0.3.0')
    c.close()

    const err = openError(() => openDb(dbPath, { migrationsFolder: migrationsWith('base'), appVersion: '0.2.0' }))
    expect(err.kind).toBe('too_new')
    expect(err.message).toContain('Plutus 0.3.0')
    expect(err.message).toContain('(0.2.0)')
  })
})

describe('a new database that fails to migrate', () => {
  function expectNoDatabaseFiles(): void {
    for (const suffix of ['', '-wal', '-shm']) expect(existsSync(dbPath + suffix)).toBe(false)
  }

  it('is deleted when the checks after migrating fail, so the next start retries', () => {
    const folder = migrationsWith('orphan', [{ tag: '0001_orphan', sql: ORPHAN_ROW }])
    const err = openError(() => openDb(dbPath, { migrationsFolder: folder }))
    expect(err.kind).toBe('migration_failed')
    expectNoDatabaseFiles()
    expect(backups()).toEqual([])
    openDb(dbPath).$client.close()
    expect(appliedMigrations(dbPath)).toBe(1)
  })

  it('is deleted when the migration throws', () => {
    const folder = migrationsWith('broken', [{ tag: '0001_broken', sql: 'INSERT INTO no_such_table VALUES (1);' }])
    const err = openError(() => openDb(dbPath, { migrationsFolder: folder }))
    expect(err.kind).toBe('migration_failed')
    expectNoDatabaseFiles()
  })
})
