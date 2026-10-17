/**
 * Import a Postgres JSON export (api/app/export_json.py) into a fresh SQLite database.
 *
 *   PLUTUS_SECRET_KEY=... node_modules/.bin/tsx server/scripts/import-json.ts <export.json> [--db <path>]
 *
 * The target defaults to PLUTUS_DB_PATH, else <PLUTUS_DATA_DIR>/plutus.sqlite. Steps are in
 * docs/MIGRATING_DATA.md. The export holds the SimpleFIN access URL in clear text: delete it
 * after the import.
 *
 * Rules (brief 2D):
 * - Money strings become integer cents through parseMoney.
 * - Dates stay YYYY-MM-DD text. Timestamps (columns ending in _at, and as_of) become exactly
 *   new Date(x).toISOString(): UTC with milliseconds and Z, as the server writes them, because
 *   timestamps are compared and ordered as text. Python's microseconds are truncated.
 * - Booleans become 0/1. Exported ids are kept; transactions.transfer_pair_id refers to its own
 *   table, so it is filled in a second pass.
 * - sqlite_sequence ends at or above both the highest id and Postgres's sequence value, so no
 *   id is ever reused (change dismissal keys embed ids).
 * - The seeded categories are replaced by the exported ones, ids included.
 * - Settings marked is_encrypted arrive in the clear and are encrypted with the SecretStore.
 * - The target must hold nothing but the seed: the Plaid categories, plus the config rows a
 *   desktop writes on its first launch (CONFIG_KEYS and config_seeded_at), which are replaced.
 *   Everything runs in one transaction, and the row count of every table is checked against
 *   the file before the runtime config is applied and the import commits.
 * - runtime_config (the Python app's env settings) is stored through the config service's
 *   updateConfig: the API key is encrypted with the SecretStore and the database is marked
 *   seeded, so env defaults never override the imported values.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { type RuntimeDefaults, loadConfig } from '../src/config.js'
import { type Db, MIGRATIONS_FOLDER, openDb } from '../src/db/index.js'
import * as schema from '../src/db/schema.js'
import { isPlainDate } from '../src/lib/dates.js'
import { parseMoney } from '../src/lib/money.js'
import { ConfigUpdate } from '../src/schemas/settings.js'
import { KeySecretStore, type SecretStore } from '../src/secrets.js'
import { CONFIG_KEYS, CONFIG_SEEDED_AT, type ConfigChanges, updateConfig } from '../src/services/config.js'

export const EXPORT_FORMAT = 'plutus-export'
export const EXPORT_FORMAT_VERSION = 2
/** The Alembic revision whose final schema db/schema.ts mirrors (brief 0A). */
export const SOURCE_REVISION = '0006'

/** Parents before children: the order the export writes and the importer inserts. */
const TABLES: readonly SQLiteTable[] = [
  schema.accounts,
  schema.balanceSnapshots,
  schema.categories,
  schema.merchantClassifications,
  schema.rules,
  schema.goals,
  schema.syncRuns,
  schema.appSettings,
  schema.changeDismissals,
  schema.transactions,
  schema.categorizations,
  schema.manualEntries,
  schema.recurrences,
  schema.suggestions,
]

export const IMPORT_TABLES: readonly string[] = TABLES.map((t) => getTableConfig(t).name)

export type ImportCounts = Record<string, number>

/** The export cannot be imported; nothing was written. */
export class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

type Kind = 'money' | 'boolean' | 'integer' | 'date' | 'timestamp' | 'text'

interface Column {
  name: string
  kind: Kind
}

interface Table {
  name: string
  columns: Column[]
  hasId: boolean
}

function kindOf(column: SQLiteColumn): Kind {
  switch (column.columnType) {
    case 'SQLiteCustomColumn':
      // The only custom column type in db/schema.ts is `money`.
      return 'money'
    case 'SQLiteBoolean':
      return 'boolean'
    case 'SQLiteInteger':
      return 'integer'
    case 'SQLiteText':
      if (column.name.endsWith('_at') || column.name === 'as_of') return 'timestamp'
      if (column.name.endsWith('_on') || column.name.endsWith('_date')) return 'date'
      return 'text'
    default:
      throw new Error(`import-json: no conversion for ${column.name} (${column.columnType})`)
  }
}

const TABLE_INFO: readonly Table[] = TABLES.map((t) => {
  const config = getTableConfig(t)
  return {
    name: config.name,
    columns: config.columns.map((c) => ({ name: c.name, kind: kindOf(c) })),
    hasId: config.columns.some((c) => c.name === 'id'),
  }
})

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
type Obj = { [key: string]: Json }
type Value = string | number | null

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i])

/** An explicit offset is required: without one, Date reads the text as local time. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function convert(table: string, column: Column, value: Json | undefined, secrets: SecretStore | null): Value {
  const where = `${table}.${column.name}`
  const bad = (expected: string) => new ImportError(`${where}: expected ${expected}, got ${JSON.stringify(value)}`)
  if (value === null || value === undefined) return null
  switch (column.kind) {
    case 'money':
      if (typeof value !== 'string') throw bad('a decimal string')
      try {
        return parseMoney(value)
      } catch {
        throw bad('a decimal string')
      }
    case 'boolean':
      if (typeof value !== 'boolean') throw bad('a boolean')
      return value ? 1 : 0
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw bad('an integer')
      return value
    case 'date':
      if (typeof value !== 'string' || !isPlainDate(value)) throw bad('a YYYY-MM-DD date')
      return value
    case 'timestamp': {
      if (typeof value !== 'string' || !TIMESTAMP.test(value)) throw bad('an ISO 8601 timestamp with an offset')
      const instant = new Date(value)
      if (Number.isNaN(instant.getTime())) throw bad('an ISO 8601 timestamp with an offset')
      return instant.toISOString()
    }
    case 'text':
      if (typeof value !== 'string') throw bad('text')
      return secrets ? secrets.encrypt(value) : value
  }
}

/** runtime_config carries every ConfigUpdate field. */
const RUNTIME_CONFIG_KEYS = Object.keys(ConfigUpdate.shape).sort()

/** app_settings rows the config service writes on a first launch: seed, not data. */
const CONFIG_ROW_KEYS: readonly string[] = [...Object.values(CONFIG_KEYS), CONFIG_SEEDED_AT]
const CONFIG_ROW_PARAMS = CONFIG_ROW_KEYS.map(() => '?').join(', ')

function parseRuntimeConfig(value: Json | undefined): ConfigChanges {
  if (!isObj(value)) throw new ImportError('export has no runtime_config object')
  const keys = Object.keys(value).sort()
  if (!sameKeys(keys, RUNTIME_CONFIG_KEYS)) {
    const missing = RUNTIME_CONFIG_KEYS.filter((k) => !keys.includes(k))
    const extra = keys.filter((k) => !RUNTIME_CONFIG_KEYS.includes(k))
    throw new ImportError(
      'runtime_config does not match the config' +
        (missing.length ? `; missing ${missing.join(', ')}` : '') +
        (extra.length ? `; unknown ${extra.join(', ')}` : ''),
    )
  }
  const result = ConfigUpdate.safeParse(value)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `runtime_config.${i.path.join('.')}: ${i.message}`)
    throw new ImportError(issues.join('; '))
  }
  return result.data
}

interface Parsed {
  runtimeConfig: ConfigChanges
  sequences: Record<string, number>
  tables: Record<string, Obj[]>
}

function parse(data: unknown): Parsed {
  if (!isObj(data)) throw new ImportError('not a Plutus export: expected a JSON object')
  if (data.format !== EXPORT_FORMAT) {
    throw new ImportError(`not a Plutus export: format is ${JSON.stringify(data.format)}, expected "${EXPORT_FORMAT}"`)
  }
  if (data.format_version !== EXPORT_FORMAT_VERSION) {
    throw new ImportError(
      `unsupported format_version ${JSON.stringify(data.format_version)}: this importer reads ${EXPORT_FORMAT_VERSION}`,
    )
  }
  if (data.alembic_revision !== SOURCE_REVISION) {
    throw new ImportError(
      `export is from Alembic revision ${JSON.stringify(data.alembic_revision)}; this importer reads ${SOURCE_REVISION}`,
    )
  }
  const tables = data.tables
  if (!isObj(tables)) throw new ImportError('export has no tables object')
  const names = Object.keys(tables)
  for (const name of names) {
    if (!IMPORT_TABLES.includes(name)) throw new ImportError(`export has an unknown table: ${name}`)
  }
  const parsedTables: Record<string, Obj[]> = {}
  for (const table of TABLE_INFO) {
    const rows = tables[table.name]
    if (!Array.isArray(rows)) throw new ImportError(`export is missing table ${table.name}`)
    const expected = table.columns.map((c) => c.name).sort()
    parsedTables[table.name] = rows.map((row, i) => {
      if (!isObj(row)) throw new ImportError(`${table.name} row ${i}: expected an object`)
      const keys = Object.keys(row).sort()
      if (!sameKeys(keys, expected)) {
        const missing = expected.filter((k) => !keys.includes(k))
        const extra = keys.filter((k) => !expected.includes(k))
        throw new ImportError(
          `${table.name} row ${i}: columns do not match the schema` +
            (missing.length ? `; missing ${missing.join(', ')}` : '') +
            (extra.length ? `; unknown ${extra.join(', ')}` : ''),
        )
      }
      return row
    })
  }
  const sequences = data.sequences
  if (!isObj(sequences)) throw new ImportError('export has no sequences object')
  const parsedSequences: Record<string, number> = {}
  for (const table of TABLE_INFO.filter((t) => t.hasId)) {
    const value = sequences[table.name]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new ImportError(`export sequences.${table.name} is missing or not a non-negative integer`)
    }
    parsedSequences[table.name] = value
  }
  return { runtimeConfig: parseRuntimeConfig(data.runtime_config), sequences: parsedSequences, tables: parsedTables }
}

interface SeedCategory {
  primary: string
  detailed: string
  label: string
  description: string | null
}

/** Refuse anything but a freshly opened database: empty tables and the untouched seed. */
function assertPristine(db: Db, migrationsFolder: string): void {
  for (const table of TABLE_INFO) {
    if (table.name === 'categories') continue
    const n =
      table.name === 'app_settings'
        ? (db.$client
            .prepare(`SELECT count(*) FROM app_settings WHERE key NOT IN (${CONFIG_ROW_PARAMS})`)
            .pluck()
            .get(...CONFIG_ROW_KEYS) as number)
        : (db.$client.prepare(`SELECT count(*) FROM ${quote(table.name)}`).pluck().get() as number)
    if (n > 0) {
      throw new ImportError(
        `target database is not empty: ${table.name} has ${n} row(s); import only into a new database`,
      )
    }
  }
  const seed = JSON.parse(readFileSync(join(migrationsFolder, 'seed', 'categories.json'), 'utf8')) as SeedCategory[]
  const rows = db.$client
    .prepare('SELECT id, "primary", detailed, label, description, is_hidden, is_custom FROM categories ORDER BY id')
    .all() as Record<string, unknown>[]
  const untouched =
    rows.length === seed.length &&
    rows.every((row, i) => {
      const s = seed[i]
      return (
        s !== undefined &&
        row.id === i + 1 &&
        row.primary === s.primary &&
        row.detailed === s.detailed &&
        row.label === s.label &&
        row.description === s.description &&
        row.is_hidden === 0 &&
        row.is_custom === 0
      )
    })
  if (!untouched) {
    throw new ImportError('target database is not empty: categories differ from the seed; import only into a new database')
  }
}

function insertTable(db: Db, table: Table, rows: Obj[], secrets: SecretStore): Obj[] {
  const names = table.columns.map((c) => c.name)
  const insert = db.$client.prepare(
    `INSERT INTO ${quote(table.name)} (${names.map(quote).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  )
  const pairs: Obj[] = []
  for (const row of rows) {
    const encrypted = table.name === 'app_settings' && row.is_encrypted === true
    const values = table.columns.map((column) => {
      if (table.name === 'transactions' && column.name === 'transfer_pair_id') return null
      return convert(table.name, column, row[column.name], encrypted && column.name === 'value' ? secrets : null)
    })
    insert.run(values)
    if (table.name === 'transactions' && row.transfer_pair_id !== null) pairs.push(row)
  }
  return pairs
}

/** The self-reference: set after every transaction exists. Raw SQL, so updated_at stays. */
function linkTransferPairs(db: Db, rows: Obj[]): void {
  const column = TABLE_INFO.find((t) => t.name === 'transactions')?.columns.find((c) => c.name === 'transfer_pair_id')
  if (!column) throw new Error('import-json: transactions.transfer_pair_id is not in the schema')
  const update = db.$client.prepare('UPDATE transactions SET transfer_pair_id = ? WHERE id = ?')
  for (const row of rows) {
    update.run(convert('transactions', column, row.transfer_pair_id, null), row.id)
  }
}

function raiseSequences(db: Db, sequences: Record<string, number>): void {
  const current = db.$client.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').pluck()
  const update = db.$client.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?')
  const insert = db.$client.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)')
  for (const [name, exported] of Object.entries(sequences)) {
    const maxId = db.$client.prepare(`SELECT coalesce(max(id), 0) FROM ${quote(name)}`).pluck().get() as number
    const seq = current.get(name) as number | undefined
    const target = Math.max(exported, maxId, seq ?? 0)
    if (seq === undefined) insert.run(name, target)
    else if (seq < target) update.run(target, name)
  }
}

export interface ImportOptions {
  /** Where the seed lives, if openDb was given a different migrations folder. */
  migrationsFolder?: string
  /** The config service's env defaults; loadConfig().defaults when not given. */
  defaults?: RuntimeDefaults
}

/**
 * Import a parsed export file into `db`, which must be freshly opened with openDb. Secrets are
 * encrypted with `secrets`: KeySecretStore headless, the desktop's safeStorage store later.
 * Returns the row count per table as exported; app_settings then also holds the runtime config
 * rows. Throws ImportError, or a SQLite error, having written nothing.
 */
export function importExport(db: Db, data: unknown, secrets: SecretStore, options: ImportOptions = {}): ImportCounts {
  const parsed = parse(data)
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER
  const defaults = options.defaults ?? loadConfig().defaults
  const run = db.$client.transaction((): ImportCounts => {
    assertPristine(db, migrationsFolder)
    db.$client.prepare('DELETE FROM categories').run()
    db.$client.prepare(`DELETE FROM app_settings WHERE key IN (${CONFIG_ROW_PARAMS})`).run(...CONFIG_ROW_KEYS)
    let pairs: Obj[] = []
    for (const table of TABLE_INFO) {
      const found = insertTable(db, table, parsed.tables[table.name] ?? [], secrets)
      if (table.name === 'transactions') pairs = found
    }
    linkTransferPairs(db, pairs)
    raiseSequences(db, parsed.sequences)
    const counts: ImportCounts = {}
    for (const table of TABLE_INFO) {
      const expected = parsed.tables[table.name]?.length ?? 0
      const actual = db.$client.prepare(`SELECT count(*) FROM ${quote(table.name)}`).pluck().get() as number
      if (actual !== expected) {
        throw new ImportError(`${table.name}: ${actual} rows after the import, the export has ${expected}`)
      }
      counts[table.name] = actual
    }
    updateConfig(db, secrets, defaults, parsed.runtimeConfig)
    return counts
  })
  return run()
}

export interface Output {
  log(message: string): void
  error(message: string): void
}

const USAGE = 'usage: PLUTUS_SECRET_KEY=... tsx server/scripts/import-json.ts <export.json> [--db <path>]'

/** The command line: returns the exit code. */
export function runCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  out: Output = console,
): number {
  const args = [...argv]
  let dbPath: string | undefined
  const at = args.indexOf('--db')
  if (at !== -1) {
    dbPath = args[at + 1]
    args.splice(at, 2)
  }
  const [file, ...rest] = args
  if (file === undefined || rest.length > 0 || (at !== -1 && !dbPath)) {
    out.error(USAGE)
    return 2
  }
  const secretKey = env.PLUTUS_SECRET_KEY
  if (!secretKey) {
    out.error('PLUTUS_SECRET_KEY is not set: it encrypts the SimpleFIN access URL in the new database')
    return 2
  }
  const target = resolve(dbPath ?? loadConfig(env).databasePath)

  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    out.error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const db = openDb(target)
  try {
    const counts = importExport(db, data, new KeySecretStore(secretKey), { defaults: loadConfig(env).defaults })
    for (const [name, n] of Object.entries(counts)) out.log(`${name.padEnd(26)} ${String(n).padStart(7)}`)
    out.log('runtime config (LLM provider, owner name tokens, sync settings, API key) stored in app_settings')
    out.log(`imported into ${target}. Delete ${file} now: it holds secrets in clear text.`)
    return 0
  } catch (err) {
    out.error(`import refused, nothing written: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  } finally {
    db.$client.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli(process.argv.slice(2)))
}
