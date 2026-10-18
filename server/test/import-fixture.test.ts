/**
 * The import check without Postgres: one real export of the demo data (fixtures/demo-export.json,
 * fake secrets) imported into SQLite must give the exporter's row counts, the monthly reports
 * the exporting app answered, and the secrets re-encrypted with the new key.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IMPORT_TABLES, importExport } from '../scripts/import-json.js'
import { loadConfig } from '../src/config.js'
import { type Db } from '../src/db/index.js'
import { KeySecretStore } from '../src/secrets.js'
import { CONFIG_KEYS, CONFIG_SEEDED_AT, runtimeConfig } from '../src/services/config.js'
import { FIXTURES, makeApp, makeDb } from './setup.js'

interface Expected {
  today: string
  counts: Record<string, number>
  secrets: { simplefin_access_url: string; anthropic_api_key: string }
  monthly: Record<string, unknown>
}

const exported = JSON.parse(readFileSync(join(FIXTURES, 'demo-export.json'), 'utf8')) as {
  runtime_config: Record<string, unknown>
}
const expected = JSON.parse(readFileSync(join(FIXTURES, 'demo-export.expected.json'), 'utf8')) as Expected
const secrets = new KeySecretStore('import-fixture-test-only-not-a-secret')
const CONFIG_ROWS = [...Object.values(CONFIG_KEYS), CONFIG_SEEDED_AT]

let db: Db
beforeEach(() => {
  db = makeDb()
  importExport(db, exported, secrets)
})
afterEach(() => {
  db.$client.close()
  vi.unstubAllEnvs()
})

const count = (sql: string, ...params: string[]) => db.$client.prepare(sql).pluck().get(...params) as number

describe('the demo export fixture', () => {
  it('imports every table with the row counts the export came from', () => {
    const counts: Record<string, number> = {}
    for (const t of IMPORT_TABLES) counts[t] = count(`SELECT count(*) FROM "${t}"`)
    // The runtime config rows are new in SQLite's app_settings: count them apart.
    const configRows = count(
      `SELECT count(*) FROM app_settings WHERE key IN (${CONFIG_ROWS.map(() => '?').join(', ')})`,
      ...CONFIG_ROWS,
    )
    counts.app_settings = (counts.app_settings ?? 0) - configRows
    expect(counts).toEqual(expected.counts)
    expect(Object.keys(expected.counts).sort()).toEqual([...IMPORT_TABLES].sort())
  })

  it('answers the monthly reports the exporting app answered', async () => {
    vi.stubEnv('PLUTUS_TODAY', expected.today)
    const { app } = makeApp({ db, secrets })
    for (const [path, body] of Object.entries(expected.monthly)) {
      const res = await app.request(path)
      expect(res.status, path).toBe(200)
      expect(await res.json(), path).toEqual(body)
    }
  })

  it('re-encrypts the SimpleFIN URL and the API key with the new key', () => {
    const blob = (key: string) =>
      db.$client.prepare('SELECT value FROM app_settings WHERE key = ? AND is_encrypted = 1').pluck().get(key) as string
    const url = blob('simplefin_access_url')
    expect(url).not.toContain('bridge.invalid')
    expect(secrets.decrypt(url)).toBe(expected.secrets.simplefin_access_url)
    expect(secrets.decrypt(blob(CONFIG_KEYS.anthropicApiKey))).toBe(expected.secrets.anthropic_api_key)
  })

  it('carries the runtime config over', () => {
    const rc = exported.runtime_config
    expect(runtimeConfig(db, secrets, loadConfig({}).defaults)).toEqual({
      llmProvider: rc.llm_provider,
      llmModel: rc.llm_model,
      anthropicApiKeySet: true,
      ollamaBaseUrl: rc.ollama_base_url,
      ownerNameTokens: rc.owner_name_tokens,
      syncIntervalHours: rc.sync_interval_hours,
      syncFirstHistoryDays: rc.sync_first_history_days,
      schedulerEnabled: rc.scheduler_enabled,
    })
  })
})
