/**
 * Open the SQLite database: pragmas, migrations, and the category seed. Migrations run at app
 * start because a desktop has no release step, so openDb guards them (safety.ts): refuse data
 * newer than the app, back up before migrating, migrate with foreign keys off, check, and
 * restore the backup if the checks fail.
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import {
  APP_VERSION,
  DatabaseOpenError,
  backupBeforeMigrating,
  bundledMigrations,
  guardSchema,
  hasData,
  pendingMigrations,
  postMigrationProblems,
  recordAppVersion,
  restoreBackup,
} from './safety.js'
import * as schema from './schema.js'

export {
  APP_VERSION,
  DatabaseOpenError,
  type DatabaseOpenErrorKind,
  KEEP_BACKUPS,
  LAST_APP_VERSION_KEY,
} from './safety.js'

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database }

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url))

export interface OpenDbOptions {
  /** Where the drizzle-kit migrations and seed live; packaged apps may relocate them. */
  migrationsFolder?: string
  /** Where pre-migration backups go; defaults to `backups/` beside the database file. */
  backupDir?: string
  /** Recorded as last_app_version and named by the schema guard; the desktop passes its own. */
  appVersion?: string
}

interface SeedCategory {
  primary: string
  detailed: string
  label: string
  description: string | null
}

/**
 * Plaid's Personal Finance Categories v2. Applied once, to an empty categories table, in file
 * order so ids are stable.
 */
export function seedCategories(db: Db, migrationsFolder = MIGRATIONS_FOLDER): void {
  const existing = db.$client.prepare('SELECT count(*) FROM categories').pluck().get() as number
  if (existing > 0) return
  const rows = JSON.parse(
    readFileSync(join(migrationsFolder, 'seed', 'categories.json'), 'utf8'),
  ) as SeedCategory[]
  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(schema.categories)
        .values({ ...row, is_hidden: false, is_custom: false })
        .run()
    }
  })
}

function isFilePath(path: string): boolean {
  return path !== '' && path !== ':memory:' && !path.startsWith('file:')
}

/**
 * Open, guard, back up, migrate, check, and seed. Throws a DatabaseOpenError, with the
 * connection closed, when the data is newer than the app, the backup fails, the migration
 * fails, or the checks after it fail; in the last case the backup has been restored.
 * Backups are only for a database file that already has tables and pending migrations; a
 * new database file that fails to migrate is deleted instead, so the next start retries.
 */
export function openDb(path: string, options: OpenDbOptions = {}): Db {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER
  const isFile = isFilePath(path)
  if (isFile) mkdirSync(dirname(path), { recursive: true })
  const backupDir = options.backupDir ?? join(dirname(path), 'backups')
  const appVersion = options.appVersion ?? APP_VERSION
  const client = new Database(path)
  try {
    client.pragma('journal_mode = WAL')
    // Off while migrating, outside any transaction: SQLite ignores this pragma inside one, and
    // with it on, a table rebuild's DROP TABLE cascades into the child tables.
    client.pragma('foreign_keys = OFF')
    // Explicitly the modern rename: ALTER TABLE __new_x RENAME TO x rewrites the references in
    // other tables, views, and triggers instead of leaving them pointing at a dropped name.
    client.pragma('legacy_alter_table = OFF')
    const bundled = bundledMigrations(migrationsFolder)
    guardSchema(client, bundled, appVersion)
    const next = pendingMigrations(client, bundled)[0]
    const isNewFile = isFile && !hasData(client)
    const backupPath =
      next !== undefined && isFile && !isNewFile
        ? backupBeforeMigrating(client, path, backupDir, next.tag)
        : null

    const db = drizzle({ client, schema })
    if (next !== undefined) {
      try {
        migrate(db, { migrationsFolder })
      } catch (err) {
        if (isNewFile) discardNewDatabase(client, path, String(err), err)
        throw new DatabaseOpenError(
          'migration_failed',
          `Plutus could not update your data to this version (${String(err)}). ` +
            'Your data has not been changed. Reinstall the previous version of Plutus.',
          { backupPath, cause: err },
        )
      }
      const problems = postMigrationProblems(client)
      if (problems.length > 0) {
        if (isNewFile) discardNewDatabase(client, path, problems.join('; '))
        failChecks(client, path, backupPath, backupDir, problems)
      }
    }
    client.pragma('foreign_keys = ON')
    seedCategories(db, migrationsFolder)
    if (isFile) recordAppVersion(client, appVersion)
    return db
  } catch (err) {
    if (client.open) client.close()
    throw err
  }
}

/**
 * Close the database on shutdown: fold the WAL into the main file (TRUNCATE leaves a 0-byte
 * -wal), let SQLite refresh its planner statistics, then close. Safe on null, on a closed
 * handle, and on a read-only or in-memory database, where the pragmas may fail.
 */
export function closeDb(db: Db | null | undefined): void {
  const client = db?.$client
  if (client === undefined || !client.open) return
  try {
    client.pragma('wal_checkpoint(TRUNCATE)')
    client.pragma('optimize')
  } catch {
    // Nothing to checkpoint or no right to write: closing is still correct.
  }
  client.close()
}

/** A database file created by this open failed to migrate: it holds no user data, so delete it. */
function discardNewDatabase(client: Database.Database, path: string, reason: string, cause?: unknown): never {
  client.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
  throw new DatabaseOpenError(
    'migration_failed',
    `Plutus could not set up a new database (${reason}). It held no data and was removed; ` +
      'Plutus will try again at the next start.',
    { cause },
  )
}

/** The checks after migrating failed: put the backup back, or say there was none. */
function failChecks(
  client: Database.Database,
  path: string,
  backupPath: string | null,
  backupDir: string,
  problems: string[],
): never {
  const found = problems.join('; ')
  client.close()
  if (backupPath === null) {
    throw new DatabaseOpenError(
      'migration_failed',
      `Updating the database left it inconsistent (${found}), and there was no backup to restore.`,
    )
  }
  let failedPath: string
  try {
    failedPath = restoreBackup(path, backupPath, backupDir)
  } catch (err) {
    throw new DatabaseOpenError(
      'migration_failed',
      `Updating your data failed its checks (${found}), and restoring the backup also failed ` +
        `(${String(err)}). Your data from before the update is in ${backupPath}; copy it to ${path} by hand.`,
      { backupPath, cause: err },
    )
  }
  throw new DatabaseOpenError(
    'restored',
    `Updating your data failed its checks (${found}), so Plutus restored the backup it made just ` +
      `before. Nothing was lost. The backup is ${backupPath}; the rejected copy is ${failedPath}. ` +
      'Reinstall the previous version of Plutus.',
    { backupPath },
  )
}
