/**
 * The SQLite importer (server/scripts/import-json.ts, brief 2D) on a small hand-written export
 * in the shape api/app/export_json.py writes. No Postgres, no app: an in-memory SQLite file
 * opened with the server's openDb, so it is migrated and seeded like a fresh desktop install.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IMPORT_TABLES, ImportError, importExport, runCli } from '../../server/scripts/import-json.ts'
import { type Db, MIGRATIONS_FOLDER, openDb } from '../../server/src/db/index.ts'
import { KeySecretStore, type SecretStore } from '../../server/src/secrets.ts'

type Row = Record<string, string | number | boolean | null>
interface ExportFile {
  format: string
  format_version: number
  alembic_revision: string
  exported_at: string
  sequences: Record<string, number>
  tables: Record<string, Row[]>
}

const FAKE_ACCESS_URL = 'https://demo-user:demo-pass@bridge.invalid/simplefin'
const KEY = 'import-test-only-not-a-secret'
const STAMP = '2026-10-17T23:06:07.214159+00:00'
const STAMP_JS = '2026-10-17T23:06:07.214Z'
const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

interface SeedCategory {
  primary: string
  detailed: string
  label: string
  description: string | null
}
const SEED = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'seed', 'categories.json'), 'utf8')) as SeedCategory[]

/** A small export: every table has rows, a transfer pair, a custom category, one secret. */
function sample(): ExportFile {
  const categories: Row[] = SEED.map((c, i) => ({
    id: i + 1,
    primary: c.primary,
    detailed: c.detailed,
    label: c.label,
    description: c.description,
    is_hidden: i === 4, // the owner hid one seed category
    is_custom: false,
  }))
  // Two custom categories were created and deleted (128, 129); 130 survives.
  categories.push({
    id: 130,
    primary: 'CUSTOM',
    detailed: 'CUSTOM_PETS',
    label: 'Pets',
    description: null,
    is_hidden: false,
    is_custom: true,
  })
  return {
    format: 'plutus-export',
    format_version: 1,
    alembic_revision: '0006',
    exported_at: '2026-10-17T23:10:00.000001+00:00',
    sequences: {
      accounts: 2,
      balance_snapshots: 2,
      categories: 131,
      rules: 1,
      goals: 3,
      sync_runs: 1,
      transactions: 15,
      manual_entries: 4,
      recurrences: 1,
      suggestions: 1,
    },
    tables: {
      accounts: [
        { id: 1, provider: 'demo', external_id: 'ACT-chk-001', name: 'Everyday Checking', type: 'checking', institution_name: 'Example Bank', currency: 'USD', is_active: true, created_at: STAMP, updated_at: STAMP },
        { id: 2, provider: 'demo', external_id: 'ACT-sav-001', name: 'Rainy Day Savings', type: 'savings', institution_name: null, currency: 'USD', is_active: false, created_at: STAMP, updated_at: STAMP },
      ],
      balance_snapshots: [
        { id: 1, account_id: 1, balance: '1234.56', available: null, as_of: '2026-09-30T12:00:00+00:00' },
        { id: 2, account_id: 2, balance: '-50.10', available: '100.00', as_of: '2026-09-30T12:00:00.5+00:00' },
      ],
      categories,
      merchant_classifications: [
        { merchant_key: 'PET SHOP', category_id: 130, essentiality: 'flexible', confidence: 'high', source: 'manual', updated_at: STAMP },
      ],
      rules: [{ id: 1, match_type: 'contains', pattern: 'PET SHOP', category_id: 130, essentiality: null, created_at: STAMP }],
      goals: [
        { id: 3, name: 'Emergency fund', target_amount: '6000.00', target_date: '2027-09-30', starting_amount: '0.00', is_active: true, created_at: STAMP, updated_at: STAMP },
      ],
      sync_runs: [
        { id: 1, provider: 'demo', trigger: 'manual', status: 'success', started_at: STAMP, finished_at: null, added: 3, updated: 0, error_text: null, requests: 2 },
      ],
      app_settings: [
        { key: 'simplefin_access_url', value: FAKE_ACCESS_URL, is_encrypted: true, updated_at: STAMP },
        { key: 'simplefin_connected_at', value: '2026-01-01T00:00:00+00:00', is_encrypted: false, updated_at: STAMP },
      ],
      change_dismissals: [{ key: 'S6:transaction:11', signal: 'S6', dismissed_at: STAMP }],
      transactions: [
        { id: 10, account_id: 1, external_id: 'TRN-1', posted_on: '2026-03-04', transacted_at: '2026-03-03T23:02:03.456789+00:00', amount: '-1000.00', raw_description: 'TRANSFER TO SAVINGS', payee: null, memo: null, pending: false, merchant_key: 'TRANSFER TO SAVINGS', note: null, one_time: false, is_transfer: true, transfer_pair_id: 12, created_at: STAMP, updated_at: STAMP },
        { id: 11, account_id: 1, external_id: 'TRN-2', posted_on: '2026-03-05', transacted_at: null, amount: '-15.40', raw_description: 'PET SHOP #12', payee: 'Pet Shop', memo: 'treats', pending: true, merchant_key: 'PET SHOP', note: 'For the dog', one_time: true, is_transfer: false, transfer_pair_id: null, created_at: STAMP, updated_at: STAMP },
        { id: 12, account_id: 2, external_id: 'TRN-3', posted_on: '2026-03-05', transacted_at: '2026-03-05T01:00:00+02:00', amount: '1000.00', raw_description: 'TRANSFER FROM CHECKING', payee: null, memo: null, pending: false, merchant_key: 'TRANSFER FROM CHECKING', note: null, one_time: false, is_transfer: true, transfer_pair_id: 10, created_at: STAMP, updated_at: STAMP },
      ],
      categorizations: [
        { transaction_id: 10, category_id: 1, essentiality: null, source: 'rule', confidence: 'very_high', updated_at: STAMP },
        { transaction_id: 11, category_id: 130, essentiality: 'flexible', source: 'manual', confidence: 'high', updated_at: STAMP },
        { transaction_id: 12, category_id: 1, essentiality: null, source: 'rule', confidence: 'very_high', updated_at: STAMP },
      ],
      manual_entries: [
        { id: 4, amount: '-200.00', description: 'Vet bill', category_id: 130, due_date: '2026-03-01', recurrence: 'none', end_date: null, fulfilled_transaction_id: 11, created_at: STAMP, updated_at: STAMP },
      ],
      recurrences: [
        { id: 1, merchant_key: 'PET SHOP', account_id: 1, amount: '-15.99', cadence: 'monthly', next_expected_date: '2026-04-05', last_seen_on: '2026-03-05', status: 'confirmed', essentiality: 'flexible', created_at: STAMP, updated_at: STAMP },
      ],
      suggestions: [
        { id: 1, goal_id: 3, text: 'Buy treats in bulk', category_id: 130, estimated_monthly_saving: '25.50', status: 'open', created_at: STAMP, updated_at: STAMP },
      ],
    },
  }
}

const dbs: Db[] = []
function freshDb(): Db {
  const db = openDb(':memory:')
  dbs.push(db)
  return db
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.$client.close()
})

const store = () => new KeySecretStore(KEY)
const all = (db: Db, sql: string, ...params: unknown[]) =>
  db.$client.prepare(sql).all(...params) as Record<string, unknown>[]
const one = (db: Db, sql: string, ...params: unknown[]) =>
  db.$client.prepare(sql).get(...params) as Record<string, unknown>
const count = (db: Db, table: string) => db.$client.prepare(`SELECT count(*) FROM "${table}"`).pluck().get() as number

function imported(data: ExportFile = sample(), secrets: SecretStore = store()): Db {
  const db = freshDb()
  importExport(db, data, secrets)
  return db
}

describe('importExport', () => {
  it('imports every table in foreign-key order and returns per-table row counts', () => {
    const data = sample()
    const db = freshDb()

    const counts = importExport(db, data, store())

    expect(IMPORT_TABLES).toEqual([
      'accounts',
      'balance_snapshots',
      'categories',
      'merchant_classifications',
      'rules',
      'goals',
      'sync_runs',
      'app_settings',
      'change_dismissals',
      'transactions',
      'categorizations',
      'manual_entries',
      'recurrences',
      'suggestions',
    ])
    const expected = Object.fromEntries(IMPORT_TABLES.map((t) => [t, data.tables[t]?.length]))
    expect(counts).toEqual(expected)
    for (const table of IMPORT_TABLES) expect(count(db, table)).toBe(expected[table])
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([])
  })

  it('converts money strings to integer cents', () => {
    const db = imported()

    expect(all(db, 'SELECT id, amount, typeof(amount) AS t FROM transactions ORDER BY id')).toEqual([
      { id: 10, amount: -100000, t: 'integer' },
      { id: 11, amount: -1540, t: 'integer' },
      { id: 12, amount: 100000, t: 'integer' },
    ])
    expect(all(db, 'SELECT balance, available FROM balance_snapshots ORDER BY id')).toEqual([
      { balance: 123456, available: null },
      { balance: -5010, available: 10000 },
    ])
    expect(one(db, 'SELECT target_amount, starting_amount FROM goals')).toEqual({ target_amount: 600000, starting_amount: 0 })
    expect(one(db, 'SELECT amount FROM manual_entries')).toEqual({ amount: -20000 })
    expect(one(db, 'SELECT amount FROM recurrences')).toEqual({ amount: -1599 })
    expect(one(db, 'SELECT estimated_monthly_saving AS s FROM suggestions')).toEqual({ s: 2550 })
  })

  it('normalises every timestamp to toISOString format in UTC', () => {
    const db = imported()

    expect(all(db, 'SELECT transacted_at, created_at, updated_at FROM transactions ORDER BY id')).toEqual([
      { transacted_at: '2026-03-03T23:02:03.456Z', created_at: STAMP_JS, updated_at: STAMP_JS },
      { transacted_at: null, created_at: STAMP_JS, updated_at: STAMP_JS },
      { transacted_at: '2026-03-04T23:00:00.000Z', created_at: STAMP_JS, updated_at: STAMP_JS },
    ])
    expect(all(db, 'SELECT as_of FROM balance_snapshots ORDER BY id')).toEqual([
      { as_of: '2026-09-30T12:00:00.000Z' },
      { as_of: '2026-09-30T12:00:00.500Z' },
    ])
    expect(one(db, 'SELECT started_at, finished_at FROM sync_runs')).toEqual({ started_at: STAMP_JS, finished_at: null })
    expect(one(db, 'SELECT dismissed_at FROM change_dismissals')).toEqual({ dismissed_at: STAMP_JS })
    // Setting values are text, not timestamps: they stay exactly as exported.
    expect(one(db, "SELECT value FROM app_settings WHERE key = 'simplefin_connected_at'")).toEqual({
      value: '2026-01-01T00:00:00+00:00',
    })
    // No column anywhere keeps a Python-format timestamp.
    for (const table of IMPORT_TABLES) {
      for (const row of all(db, `SELECT * FROM "${table}"`)) {
        for (const [column, value] of Object.entries(row)) {
          if (table === 'app_settings' && column === 'value') continue
          if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
            expect(value, `${table}.${column}`).toMatch(ISO_MS_Z)
          }
        }
      }
    }
  })

  it('keeps dates as YYYY-MM-DD text', () => {
    const db = imported()

    expect(one(db, 'SELECT posted_on, typeof(posted_on) AS t FROM transactions WHERE id = 10')).toEqual({
      posted_on: '2026-03-04',
      t: 'text',
    })
    expect(one(db, 'SELECT due_date, end_date FROM manual_entries')).toEqual({ due_date: '2026-03-01', end_date: null })
    expect(one(db, 'SELECT next_expected_date, last_seen_on FROM recurrences')).toEqual({
      next_expected_date: '2026-04-05',
      last_seen_on: '2026-03-05',
    })
    expect(one(db, 'SELECT target_date FROM goals')).toEqual({ target_date: '2027-09-30' })
  })

  it('stores booleans as 0 and 1', () => {
    const db = imported()

    expect(all(db, 'SELECT id, pending, is_transfer, one_time, typeof(pending) AS t FROM transactions ORDER BY id')).toEqual([
      { id: 10, pending: 0, is_transfer: 1, one_time: 0, t: 'integer' },
      { id: 11, pending: 1, is_transfer: 0, one_time: 1, t: 'integer' },
      { id: 12, pending: 0, is_transfer: 1, one_time: 0, t: 'integer' },
    ])
    expect(all(db, 'SELECT id, is_active FROM accounts ORDER BY id')).toEqual([
      { id: 1, is_active: 1 },
      { id: 2, is_active: 0 },
    ])
  })

  it('keeps exported ids, so foreign keys and the transfer pair hold', () => {
    const db = imported()

    expect(all(db, 'SELECT id, transfer_pair_id FROM transactions ORDER BY id')).toEqual([
      { id: 10, transfer_pair_id: 12 },
      { id: 11, transfer_pair_id: null },
      { id: 12, transfer_pair_id: 10 },
    ])
    expect(one(db, 'SELECT fulfilled_transaction_id AS f FROM manual_entries WHERE id = 4')).toEqual({ f: 11 })
    expect(one(db, 'SELECT goal_id, category_id FROM suggestions WHERE id = 1')).toEqual({ goal_id: 3, category_id: 130 })
    expect(all(db, 'SELECT transaction_id FROM categorizations ORDER BY transaction_id')).toEqual([
      { transaction_id: 10 },
      { transaction_id: 11 },
      { transaction_id: 12 },
    ])
  })

  it('keeps AUTOINCREMENT at or above every id Postgres handed out', () => {
    const db = imported()
    const seq = (table: string) =>
      db.$client.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').pluck().get(table) as number

    expect(seq('transactions')).toBe(15)
    expect(seq('categories')).toBe(131)
    expect(seq('goals')).toBe(3)
    expect(seq('manual_entries')).toBe(4)
    expect(seq('accounts')).toBe(2)
    const next = db.$client
      .prepare(
        "INSERT INTO transactions (account_id, external_id, posted_on, amount, raw_description) VALUES (1, 'TRN-NEW', '2026-04-01', -100, 'NEW') RETURNING id",
      )
      .pluck()
      .get()
    expect(next).toBe(16)
  })

  it('raises AUTOINCREMENT to the highest id when the exported sequence is lower', () => {
    const data = sample()
    data.sequences.transactions = 3
    const db = imported(data)

    expect(db.$client.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'transactions'").pluck().get()).toBe(12)
  })

  it('replaces the seeded categories with exactly the exported ones', () => {
    const data = sample()
    const db = imported(data)

    const rows = all(db, 'SELECT * FROM categories ORDER BY id')
    const expected = (data.tables.categories ?? []).map((c) => ({
      ...c,
      is_hidden: c.is_hidden ? 1 : 0,
      is_custom: c.is_custom ? 1 : 0,
    }))
    expect(rows).toEqual(expected)
    expect(rows).toHaveLength(SEED.length + 1)
    expect(one(db, 'SELECT is_hidden FROM categories WHERE id = 5')).toEqual({ is_hidden: 1 })
    expect(one(db, 'SELECT count(*) AS n FROM categories WHERE id IN (128, 129)')).toEqual({ n: 0 })
  })

  it('re-encrypts secret settings with the given store and leaves plain ones alone', () => {
    const db = imported()

    const secret = one(db, "SELECT value, is_encrypted FROM app_settings WHERE key = 'simplefin_access_url'")
    expect(secret.is_encrypted).toBe(1)
    expect(secret.value).not.toContain('demo-pass')
    expect(store().decrypt(String(secret.value))).toBe(FAKE_ACCESS_URL)
    expect(one(db, "SELECT is_encrypted FROM app_settings WHERE key = 'simplefin_connected_at'")).toEqual({ is_encrypted: 0 })
  })

  it('takes any SecretStore, so the desktop can pass its own', () => {
    const tagging: SecretStore = {
      encrypt: (plain) => `sealed:${Buffer.from(plain).toString('base64')}`,
      decrypt: (blob) => Buffer.from(blob.slice('sealed:'.length), 'base64').toString(),
    }
    const db = imported(sample(), tagging)

    const { value } = one(db, "SELECT value FROM app_settings WHERE key = 'simplefin_access_url'")
    expect(value).toBe(`sealed:${Buffer.from(FAKE_ACCESS_URL).toString('base64')}`)
  })

  it('refuses a database that already holds data', () => {
    const db = imported()

    expect(() => importExport(db, sample(), store())).toThrow(ImportError)
    expect(() => importExport(db, sample(), store())).toThrow(/not empty/)
    expect(count(db, 'transactions')).toBe(3)
  })

  it('refuses a database with one row beyond the seed, and changes nothing', () => {
    const db = freshDb()
    db.$client
      .prepare("INSERT INTO app_settings (key, value, is_encrypted, updated_at) VALUES ('llm_provider', 'fake', 0, ?)")
      .run(STAMP_JS)

    expect(() => importExport(db, sample(), store())).toThrow(/app_settings/)
    expect(count(db, 'accounts')).toBe(0)
    expect(count(db, 'categories')).toBe(SEED.length)
  })

  it('refuses a database whose categories differ from the seed', () => {
    const db = freshDb()
    db.$client.prepare('UPDATE categories SET is_hidden = 1 WHERE id = 1').run()

    expect(() => importExport(db, sample(), store())).toThrow(/categories/)
    expect(count(db, 'accounts')).toBe(0)
  })

  it('runs in one transaction: a bad row late in the file leaves the database untouched', () => {
    const data = sample()
    const suggestion = data.tables.suggestions?.[0]
    if (suggestion) suggestion.goal_id = 99 // no such goal
    const db = freshDb()

    expect(() => importExport(db, data, store())).toThrow()
    for (const table of IMPORT_TABLES) {
      expect(count(db, table), table).toBe(table === 'categories' ? SEED.length : 0)
    }
    expect(one(db, 'SELECT is_hidden FROM categories WHERE id = 5')).toEqual({ is_hidden: 0 })
  })

  it('rolls back when a transfer pair points at a missing transaction', () => {
    const data = sample()
    const tx = data.tables.transactions?.[0]
    if (tx) tx.transfer_pair_id = 999
    const db = freshDb()

    expect(() => importExport(db, data, store())).toThrow()
    expect(count(db, 'transactions')).toBe(0)
  })

  it('refuses a money value that is not a decimal amount', () => {
    const data = sample()
    const tx = data.tables.transactions?.[1]
    if (tx) tx.amount = '12.3.4'

    expect(() => importExport(freshDb(), data, store())).toThrow(/transactions.*amount/)
  })

  it('refuses a timestamp without a UTC offset, which would be read as local time', () => {
    const data = sample()
    const account = data.tables.accounts?.[0]
    if (account) account.created_at = '2026-10-17T23:06:07.214159'

    expect(() => importExport(freshDb(), data, store())).toThrow(/accounts.*created_at/)
  })

  it('refuses a date that is not YYYY-MM-DD', () => {
    const data = sample()
    const tx = data.tables.transactions?.[0]
    if (tx) tx.posted_on = '2026-03-04T00:00:00+00:00'

    expect(() => importExport(freshDb(), data, store())).toThrow(/transactions.*posted_on/)
  })

  it.each([
    ['format', (d: ExportFile) => void (d.format = 'something-else'), /format/],
    ['format version', (d: ExportFile) => void (d.format_version = 2), /format_version/],
    ['Alembic revision', (d: ExportFile) => void (d.alembic_revision = '0007'), /revision/],
    ['missing table', (d: ExportFile) => void delete d.tables.goals, /goals/],
    ['extra table', (d: ExportFile) => void (d.tables.users = []), /users/],
    ['missing column', (d: ExportFile) => void delete d.tables.accounts?.[0]?.currency, /accounts.*currency/],
    ['extra column', (d: ExportFile) => void ((d.tables.goals?.[0] ?? {}).colour = 'blue'), /goals.*colour/],
    ['missing sequence', (d: ExportFile) => void delete d.sequences.transactions, /sequences.*transactions/],
  ])('refuses an export with a wrong %s', (_name, mutate, message) => {
    const data = sample()
    mutate(data)
    const db = freshDb()

    expect(() => importExport(db, data, store())).toThrow(ImportError)
    expect(() => importExport(db, data, store())).toThrow(message)
    expect(count(db, 'categories')).toBe(SEED.length)
  })

  it('refuses something that is not an export at all', () => {
    expect(() => importExport(freshDb(), null, store())).toThrow(ImportError)
    expect(() => importExport(freshDb(), [1, 2], store())).toThrow(ImportError)
  })
})

describe('runCli', () => {
  const quiet = { log: () => undefined, error: () => undefined }

  function writeSample(): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'plutus-import-test-'))
    const file = join(dir, 'export.json')
    writeFileSync(file, JSON.stringify(sample()))
    return { dir, file }
  }

  it('imports a file into a new SQLite database with the key from PLUTUS_SECRET_KEY', () => {
    const { dir, file } = writeSample()
    const target = join(dir, 'data', 'plutus.sqlite')

    const code = runCli([file, '--db', target], { PLUTUS_SECRET_KEY: KEY }, quiet)

    expect(code).toBe(0)
    const db = openDb(target)
    dbs.push(db)
    expect(count(db, 'transactions')).toBe(3)
    const { value } = one(db, "SELECT value FROM app_settings WHERE key = 'simplefin_access_url'")
    expect(store().decrypt(String(value))).toBe(FAKE_ACCESS_URL)
  })

  it('uses PLUTUS_DB_PATH when --db is not given', () => {
    const { dir, file } = writeSample()
    const target = join(dir, 'env.sqlite')

    expect(runCli([file], { PLUTUS_SECRET_KEY: KEY, PLUTUS_DB_PATH: target }, quiet)).toBe(0)
    const db = openDb(target)
    dbs.push(db)
    expect(count(db, 'accounts')).toBe(2)
  })

  it('refuses to run without PLUTUS_SECRET_KEY', () => {
    const { dir, file } = writeSample()
    const errors: string[] = []

    const code = runCli([file, '--db', join(dir, 'x.sqlite')], {}, { log: () => undefined, error: (m) => errors.push(m) })

    expect(code).not.toBe(0)
    expect(errors.join('\n')).toMatch(/PLUTUS_SECRET_KEY/)
  })

  it('reports a refused import with a non-zero exit', () => {
    const { dir, file } = writeSample()
    const target = join(dir, 'twice.sqlite')
    expect(runCli([file, '--db', target], { PLUTUS_SECRET_KEY: KEY }, quiet)).toBe(0)
    const errors: string[] = []

    const code = runCli([file, '--db', target], { PLUTUS_SECRET_KEY: KEY }, { log: () => undefined, error: (m) => errors.push(m) })

    expect(code).not.toBe(0)
    expect(errors.join('\n')).toMatch(/not empty/)
  })

  it('prints usage without a file argument', () => {
    const errors: string[] = []
    expect(runCli([], { PLUTUS_SECRET_KEY: KEY }, { log: () => undefined, error: (m) => errors.push(m) })).toBe(2)
    expect(errors.join('\n')).toMatch(/usage/)
  })
})
