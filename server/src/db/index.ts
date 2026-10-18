/**
 * Open the SQLite database: pragmas, migrations, and the category seed. Migrations run at app
 * start because a desktop has no release step.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema.js'

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database }

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url))

export interface OpenDbOptions {
  /** Where the drizzle-kit migrations and seed live; packaged apps may relocate them. */
  migrationsFolder?: string
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

export function openDb(path: string, options: OpenDbOptions = {}): Db {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER
  if (path !== ':memory:' && !path.startsWith('file:')) {
    mkdirSync(dirname(path), { recursive: true })
  }
  const client = new Database(path)
  client.pragma('journal_mode = WAL')
  client.pragma('foreign_keys = ON')
  const db = drizzle({ client, schema })
  migrate(db, { migrationsFolder })
  seedCategories(db, migrationsFolder)
  return db
}
