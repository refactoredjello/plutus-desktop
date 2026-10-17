/**
 * The SQLite schema must match the final state of the Alembic migrations (0001 to 0006) and the
 * SQLAlchemy models, so a Postgres export imports without renaming (plan section 5.4).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db/index.js'
import { accounts, appSettings, categories, transactions } from '../src/db/schema.js'
import { cents } from '../src/lib/money.js'
import { FIXTURES, makeDb } from './setup.js'

type Col = [name: string, notNull: boolean]

// Final column lists, in Postgres column order, with NOT NULL as in the migrations.
const TABLES: Record<string, { pk: string[]; columns: Col[] }> = {
  accounts: {
    pk: ['id'],
    columns: [
      ['id', true],
      ['provider', true],
      ['external_id', true],
      ['name', true],
      ['type', true],
      ['institution_name', false],
      ['currency', true],
      ['is_active', true],
      ['created_at', true],
      ['updated_at', true],
    ],
  },
  app_settings: {
    pk: ['key'],
    columns: [
      ['key', true],
      ['value', true],
      ['is_encrypted', true],
      ['updated_at', true],
    ],
  },
  categories: {
    pk: ['id'],
    columns: [
      ['id', true],
      ['primary', true],
      ['detailed', true],
      ['label', true],
      ['description', false],
      ['is_hidden', true],
      ['is_custom', true],
    ],
  },
  goals: {
    pk: ['id'],
    columns: [
      ['id', true],
      ['name', true],
      ['target_amount', true],
      ['target_date', true],
      ['starting_amount', true],
      ['is_active', true],
      ['created_at', true],
      ['updated_at', true],
    ],
  },
  sync_runs: {
    pk: ['id'],
    columns: [
      ['id', true],
      ['provider', true],
      ['trigger', true],
      ['status', true],
      ['started_at', true],
      ['finished_at', false],
      ['added', true],
      ['updated', true],
      ['error_text', false],
      ['requests', true],
    ],
  },
  balance_snapshots: {
    pk: ['id'],
    columns: [
      ['id', true],
      ['account_id', true],
      ['balance', true],
      ['available', false],
      ['as_of', true],
    ],
  },
  merchant_classifications: {
    pk: ['merchant_key'],
    columns: [
      ['merchant_key', true],
      ['category_id', true],
      ['essentiality', false],
      ['confidence', true],
      ['source', true],
      ['updated_at', true],
    ],
  },
  recurrences: {
    pk: ['id'],
    columns: [
      ['id', true],
      ['merchant_key', true],
      ['account_id', true],
      ['amount', true],
      ['cadence', true],
      ['next_expected_date', true],
      ['last_seen_on', false],
      ['status', true],
      ['essentiality', false],
      ['created_at', true],
      ['updated_at', true],
    ],
  },
  rules: {
    pk: ['id'],
    columns: [
      ['id', true],
      ['match_type', true],
      ['pattern', true],
      ['category_id', true],
      ['essentiality', false],
      ['created_at', true],
    ],
  },
  suggestions: {
    pk: ['id'],
    columns: [
      ['id', true],
      ['goal_id', true],
      ['text', true],
      ['category_id', false],
      ['estimated_monthly_saving', false],
      ['status', true],
      ['created_at', true],
      ['updated_at', true],
    ],
  },
  transactions: {
    pk: ['id'],
    columns: [
      ['id', true],
      ['account_id', true],
      ['external_id', true],
      ['posted_on', true],
      ['transacted_at', false],
      ['amount', true],
      ['raw_description', true],
      ['payee', false],
      ['memo', false],
      ['pending', true],
      ['merchant_key', false],
      ['is_transfer', true],
      ['transfer_pair_id', false],
      ['created_at', true],
      ['updated_at', true],
      ['note', false],
      ['one_time', true],
    ],
  },
  categorizations: {
    pk: ['transaction_id'],
    columns: [
      ['transaction_id', true],
      ['category_id', true],
      ['essentiality', false],
      ['source', true],
      ['confidence', true],
      ['updated_at', true],
    ],
  },
  manual_entries: {
    pk: ['id'],
    columns: [
      ['id', true],
      ['amount', true],
      ['description', true],
      ['category_id', false],
      ['due_date', true],
      ['recurrence', true],
      ['end_date', false],
      ['fulfilled_transaction_id', false],
      ['created_at', true],
      ['updated_at', true],
    ],
  },
  change_dismissals: {
    pk: ['key'],
    columns: [
      ['key', true],
      ['signal', true],
      ['dismissed_at', true],
    ],
  },
}

const MONEY_COLUMNS = [
  'balance_snapshots.balance',
  'balance_snapshots.available',
  'transactions.amount',
  'manual_entries.amount',
  'recurrences.amount',
  'goals.target_amount',
  'goals.starting_amount',
  'suggestions.estimated_monthly_saving',
]

// [table, columns, name]
const UNIQUES: [string, string[], string][] = [
  ['accounts', ['provider', 'external_id'], 'uq_accounts_provider'],
  ['categories', ['detailed'], 'uq_categories_detailed'],
  ['recurrences', ['merchant_key', 'account_id'], 'uq_recurrences_merchant_key'],
  ['rules', ['match_type', 'pattern'], 'uq_rules_match_type'],
  ['transactions', ['account_id', 'external_id'], 'uq_transactions_account_id'],
]

const INDEXES: [string, string[], string][] = [
  ['balance_snapshots', ['account_id', 'as_of'], 'ix_balance_snapshots_account_as_of'],
  ['transactions', ['posted_on'], 'ix_transactions_posted_on'],
  ['transactions', ['merchant_key'], 'ix_transactions_merchant_key'],
]

// [table, column, referenced table, on delete]
const FOREIGN_KEYS: [string, string, string, string][] = [
  ['balance_snapshots', 'account_id', 'accounts', 'CASCADE'],
  ['merchant_classifications', 'category_id', 'categories', 'NO ACTION'],
  ['recurrences', 'account_id', 'accounts', 'CASCADE'],
  ['rules', 'category_id', 'categories', 'NO ACTION'],
  ['suggestions', 'category_id', 'categories', 'NO ACTION'],
  ['suggestions', 'goal_id', 'goals', 'CASCADE'],
  ['transactions', 'account_id', 'accounts', 'CASCADE'],
  ['transactions', 'transfer_pair_id', 'transactions', 'SET NULL'],
  ['categorizations', 'category_id', 'categories', 'NO ACTION'],
  ['categorizations', 'transaction_id', 'transactions', 'CASCADE'],
  ['manual_entries', 'category_id', 'categories', 'NO ACTION'],
  ['manual_entries', 'fulfilled_transaction_id', 'transactions', 'SET NULL'],
]

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  pk: number
}

describe('schema', () => {
  const db = makeDb()
  const raw = db.$client

  it('has exactly the fourteen Python tables', () => {
    const names = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .pluck()
      .all()
    expect(names).toEqual(Object.keys(TABLES).sort())
  })

  it.each(Object.entries(TABLES))('%s has the Python columns, nullability and key', (table, spec) => {
    const info = raw.prepare(`PRAGMA table_info("${table}")`).all() as ColumnInfo[]
    expect(info.map((c) => [c.name, c.notnull === 1 || c.pk > 0])).toEqual(spec.columns)
    const pk = info
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name)
    expect(pk).toEqual(spec.pk)
  })

  it('stores money as INTEGER cents', () => {
    for (const ref of MONEY_COLUMNS) {
      const [table, column] = ref.split('.')
      const info = raw.prepare(`PRAGMA table_info("${table}")`).all() as ColumnInfo[]
      expect(info.find((c) => c.name === column)?.type, ref).toBe('integer')
    }
  })

  it.each(UNIQUES)('%s has unique (%s) named %s', (table, columns, name) => {
    const list = raw.prepare(`PRAGMA index_list("${table}")`).all() as { name: string; unique: number }[]
    const match = list.filter((i) => i.unique === 1).find((i) => {
      const cols = (raw.prepare(`PRAGMA index_info("${i.name}")`).all() as { name: string }[]).map((c) => c.name)
      return JSON.stringify(cols) === JSON.stringify(columns)
    })
    expect(match, `${table}(${columns.join(', ')})`).toBeDefined()
    const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('table', 'index')").pluck().all(table)
    expect(sql.join('\n')).toContain(name)
  })

  it.each(INDEXES)('%s has index (%s) named %s', (table, columns, name) => {
    const list = raw.prepare(`PRAGMA index_list("${table}")`).all() as { name: string; unique: number }[]
    const index = list.find((i) => i.name === name)
    expect(index?.unique).toBe(0)
    const cols = (raw.prepare(`PRAGMA index_info("${name}")`).all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(columns)
  })

  it('has no other unique constraints or indexes', () => {
    const all = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'")
      .pluck()
      .all() as string[]
    const expected = [...UNIQUES.map((u) => u[2]), ...INDEXES.map((i) => i[2])]
    expect(all.filter((n) => !expected.includes(n))).toEqual([])
  })

  it('has the Python foreign keys and ON DELETE behaviour', () => {
    const found: [string, string, string, string][] = []
    for (const table of Object.keys(TABLES)) {
      const fks = raw.prepare(`PRAGMA foreign_key_list("${table}")`).all() as {
        table: string
        from: string
        on_delete: string
      }[]
      for (const fk of fks) found.push([table, fk.from, fk.table, fk.on_delete])
    }
    const key = (f: string[]) => f.join(' ')
    expect(found.map(key).sort()).toEqual(FOREIGN_KEYS.map(key).sort())
  })
})

describe('openDb', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plutus-db-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('turns on foreign keys and WAL', () => {
    const db = openDb(join(dir, 'plutus.sqlite'))
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal')
    db.$client.close()
  })

  it('enforces foreign keys', () => {
    const db = makeDb()
    expect(() =>
      db
        .insert(transactions)
        .values({
          account_id: 999,
          external_id: 'T1',
          posted_on: '2026-01-10' as never,
          amount: cents(-500),
          raw_description: 'X',
        })
        .run(),
    ).toThrow(/FOREIGN KEY/)
  })

  it('creates the data directory and is idempotent across opens', () => {
    const path = join(dir, 'nested', 'plutus.sqlite')
    openDb(path).$client.close()
    const again = openDb(path)
    expect(again.$client.prepare('SELECT count(*) FROM categories').pluck().get()).toBe(127)
    again.$client.close()
  })

  it('does not reseed a database that already has categories', () => {
    const path = join(dir, 'plutus.sqlite')
    const db = openDb(path)
    db.insert(categories).values({ primary: 'CUSTOM', detailed: 'CUSTOM_X', label: 'X', is_custom: true }).run()
    db.$client.close()
    const again = openDb(path)
    expect(again.$client.prepare('SELECT count(*) FROM categories').pluck().get()).toBe(128)
    again.$client.close()
  })

  it('applies Python client-side defaults and server timestamps in ISO UTC', () => {
    const db = makeDb()
    const row = db.insert(accounts).values({ provider: 'test', external_id: 'A1', name: 'Acct' }).returning().get()
    expect(row.type).toBe('other')
    expect(row.currency).toBe('USD')
    expect(row.is_active).toBe(true)
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    const tx = db
      .insert(transactions)
      .values({ account_id: row.id, external_id: 'T1', posted_on: '2026-01-10' as never, amount: cents(-1549), raw_description: 'X' })
      .returning()
      .get()
    expect(tx.pending).toBe(false)
    expect(tx.is_transfer).toBe(false)
    expect(tx.one_time).toBe(false)
    expect(tx.amount).toBe(-1549)
  })

  it('sets updated_at on update', () => {
    const db = makeDb()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    db.insert(appSettings).values({ key: 'k', value: 'v', updated_at: '2026-01-01T00:00:00.000Z' }).run()
    vi.setSystemTime(new Date('2026-02-03T04:05:06.789Z'))
    db.update(appSettings).set({ value: 'w' }).where(eq(appSettings.key, 'k')).run()
    const row = db.select().from(appSettings).where(eq(appSettings.key, 'k')).get()
    expect(row?.updated_at).toBe('2026-02-03T04:05:06.789Z')
  })

  it('never reuses an id after the newest row is deleted, like a Postgres sequence', () => {
    const db = makeDb()
    const a = db.insert(accounts).values({ provider: 'test', external_id: 'A1', name: 'A' }).returning().get()
    db.delete(accounts).where(eq(accounts.id, a.id)).run()
    const b = db.insert(accounts).values({ provider: 'test', external_id: 'A2', name: 'B' }).returning().get()
    expect(b.id).toBeGreaterThan(a.id)
  })
})

describe('money column', () => {
  it('refuses a non-integer amount', () => {
    const db = makeDb()
    const a = db.insert(accounts).values({ provider: 'test', external_id: 'A1', name: 'A' }).returning().get()
    expect(() =>
      db
        .insert(transactions)
        .values({ account_id: a.id, external_id: 'T1', posted_on: '2026-01-10' as never, amount: 12.5 as never, raw_description: 'X' })
        .run(),
    ).toThrow(/cents/)
  })
})

/** Port of label_for in api/alembic/versions/0002_seed_categories.py. */
const ACRONYMS: Record<string, string> = { Tv: 'TV', Atm: 'ATM' }
const capitalize = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
function labelFor(primary: string, detailed: string): string {
  const rest = detailed.startsWith(`${primary}_`) ? detailed.slice(primary.length + 1) : detailed
  const words = rest.toLowerCase().split('_')
  words[0] = capitalize(words[0] ?? '')
  return words.map((w) => ACRONYMS[capitalize(w)] ?? w).join(' ')
}

/** Minimal RFC 4180 reader for the seed CSV (quoted fields with commas and doubled quotes). */
function readCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  const [header = [], ...body] = rows
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
}

describe('category seed (alembic 0002)', () => {
  const csv = readCsv(readFileSync(join(FIXTURES, 'plaid_pfc_v2.csv'), 'utf8'))

  it('has as many rows as the Python migration inserts', () => {
    const db = makeDb()
    expect(csv).toHaveLength(127)
    expect(db.$client.prepare('SELECT count(*) FROM categories').pluck().get()).toBe(csv.length)
  })

  it('matches the Python migration row for row, ids in CSV order', () => {
    const db = makeDb()
    const rows = db.select().from(categories).orderBy(categories.id).all()
    expect(rows).toEqual(
      csv.map((r, i) => ({
        id: i + 1,
        primary: r.primary,
        detailed: r.detailed,
        label: labelFor(r.primary ?? '', r.detailed ?? ''),
        description: r.description || null,
        is_hidden: false,
        is_custom: false,
      })),
    )
  })

  it('applies the acronym labels', () => {
    const db = makeDb()
    const label = (detailed: string) =>
      db.select().from(categories).where(eq(categories.detailed, detailed)).get()?.label
    expect(label('ENTERTAINMENT_TV_AND_MOVIES')).toBe('TV and movies')
    expect(label('FOOD_AND_DRINK_COFFEE')).toBe('Coffee')
    expect(label('BANK_FEES_ATM_FEES')).toBe('ATM fees')
  })
})
