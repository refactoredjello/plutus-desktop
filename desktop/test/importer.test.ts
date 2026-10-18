import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from 'plutus-server/config'
import { type Db, openDb } from 'plutus-server/db'
import { SIMPLEFIN_ACCESS_URL, getSetting } from 'plutus-server/settings'
import { llmSettings, runtimeConfig } from 'plutus-server/runtime-config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importExportFile, importSummary } from '../src/lib/importer.js'
import { type SafeStorageLike, SafeStorageSecretStore } from '../src/lib/secrets.js'

/** The committed export of the fake demo data (fake secrets). */
const FIXTURE = fileURLToPath(new URL('../../server/test/fixtures/demo-export.json', import.meta.url))
const exported = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  runtime_config: { anthropic_api_key: string }
  tables: { app_settings: { key: string; value: string }[]; transactions: unknown[]; accounts: unknown[] }
}
const exportedUrl = exported.tables.app_settings.find((r) => r.key === SIMPLEFIN_ACCESS_URL)?.value
const exportedKey = exported.runtime_config.anthropic_api_key

const MAGIC = Buffer.from('fake-os-crypto:')

/** Stands in for Electron's safeStorage: reversible, and not the clear text. */
const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.concat([MAGIC, Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a)]),
  decryptString: (blob) => {
    if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Error while decrypting')
    return Buffer.from(blob.subarray(MAGIC.length).map((b) => b ^ 0x5a)).toString('utf8')
  },
}

describe('importExportFile', () => {
  const secrets = new SafeStorageSecretStore(fakeSafeStorage)
  const defaults = loadConfig({}).defaults
  let dir: string
  let db: Db

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plutus-desktop-import-'))
    db = openDb(join(dir, 'plutus.sqlite'))
    runtimeConfig(db, secrets, defaults) // what a first launch writes: the config seed
  })

  afterEach(() => {
    db.$client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('imports the export into the desktop database with its secrets in the OS store', () => {
    expect(exportedUrl).toBeTruthy()
    const counts = importExportFile(db, FIXTURE, secrets, defaults)
    expect(counts.transactions).toBe(exported.tables.transactions.length)
    expect(counts.accounts).toBe(exported.tables.accounts.length)

    expect(getSetting(db, secrets, SIMPLEFIN_ACCESS_URL)).toBe(exportedUrl)
    expect(llmSettings(db, secrets, defaults).anthropic_api_key).toBe(exportedKey)
    const stored = db.$client.prepare('SELECT value FROM app_settings WHERE is_encrypted = 1').pluck().all() as string[]
    expect(stored).toHaveLength(2)
    for (const blob of stored) {
      expect(blob).not.toContain('bridge.invalid')
      expect(blob).not.toContain('sk-ant')
      expect(Buffer.from(blob, 'base64').subarray(0, MAGIC.length).equals(MAGIC)).toBe(true)
    }
  })

  it('refuses a database that already holds data, writing nothing', () => {
    importExportFile(db, FIXTURE, secrets, defaults)
    const before = db.$client.prepare('SELECT count(*) FROM transactions').pluck().get()
    expect(() => importExportFile(db, FIXTURE, secrets, defaults)).toThrow(/not empty/)
    expect(db.$client.prepare('SELECT count(*) FROM transactions').pluck().get()).toBe(before)
  })

  it('reports a file it cannot read or parse without importing anything', () => {
    const garbage = join(dir, 'garbage.json')
    writeFileSync(garbage, '{ not json')
    expect(() => importExportFile(db, garbage, secrets, defaults)).toThrow(/cannot read .*garbage\.json/)
    expect(() => importExportFile(db, join(dir, 'missing.json'), secrets, defaults)).toThrow(/cannot read/)
    expect(db.$client.prepare('SELECT count(*) FROM accounts').pluck().get()).toBe(0)
  })

  it('refuses a JSON file that is not a Plutus export', () => {
    const other = join(dir, 'other.json')
    writeFileSync(other, '{"hello": "world"}')
    expect(() => importExportFile(db, other, secrets, defaults)).toThrow(/not a Plutus export/)
  })
})

describe('importSummary', () => {
  it('names the main tables and reminds that the file holds secrets', () => {
    const text = importSummary({ accounts: 4, transactions: 295, rules: 3, goals: 1, categories: 120 })
    expect(text).toContain('4 accounts')
    expect(text).toContain('295 transactions')
    expect(text).toContain('3 rules')
    expect(text).toContain('1 goal')
    expect(text).toMatch(/delete the export file/i)
  })
})
