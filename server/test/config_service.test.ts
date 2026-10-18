/**
 * The runtime config service, plus the service half of the LLM status.
 *
 * The rule under test:
 * - Seeding: the first time the config is read or updated, every knob without a row is
 *   written from the env defaults (`Config.defaults`), and a `config_seeded_at` row marks the
 *   database as seeded. Seeding never runs again, so later env changes do not reach the table
 *   and a key the user cleared stays cleared.
 * - Reads: the table wins. A knob with no row (one added after seeding) reads its env default.
 * - Headless override: `applyEnvOverrides(db, secrets, env)` writes every knob whose variable is
 *   set in `env` into the table. The headless server calls it at start, so a set variable wins
 *   until the next PUT and again at the next start. The desktop never calls it.
 * - The API key is stored encrypted; blank means none, so a blank key clears it.
 */

import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { RuntimeDefaults } from '../src/config.js'
import type { Db } from '../src/db/index.js'
import { appSettings } from '../src/db/schema.js'
import { DomainError } from '../src/lib/errors.js'
import { KeySecretStore } from '../src/secrets.js'
import { getSetting } from '../src/services/app_settings.js'
import {
  CONFIG_KEYS,
  CONFIG_SEEDED_AT,
  applyEnvOverrides,
  llmSettings,
  llmStatus,
  runtimeConfig,
  seedConfig,
  updateConfig,
} from '../src/services/config.js'
import { makeDb, testConfig } from './setup.js'

const secrets = new KeySecretStore('test-secret-key')
const API_KEY = 'sk-ant-test-0123456789'

const defaults: RuntimeDefaults = {
  llmProvider: 'claude',
  llmModel: 'claude-haiku-4-5',
  anthropicApiKey: API_KEY,
  ollamaBaseUrl: 'http://localhost:11434',
  ownerNameTokens: ['ALEX', 'SMITH'],
  syncIntervalHours: 6,
  syncFirstHistoryDays: 180,
  schedulerEnabled: true,
}

function rows(db: Db) {
  return Object.fromEntries(db.select().from(appSettings).all().map((r) => [r.key, r]))
}

function rawValues(db: Db): string {
  return JSON.stringify(db.$client.prepare('select * from app_settings').all())
}

describe('seeding', () => {
  it('seeds every knob from the env defaults on first read', () => {
    const db = makeDb()
    expect(runtimeConfig(db, secrets, defaults)).toEqual({
      llmProvider: 'claude',
      llmModel: 'claude-haiku-4-5',
      anthropicApiKeySet: true,
      ollamaBaseUrl: 'http://localhost:11434',
      ownerNameTokens: ['ALEX', 'SMITH'],
      syncIntervalHours: 6,
      syncFirstHistoryDays: 180,
      schedulerEnabled: true,
    })
    const stored = rows(db)
    expect(Object.keys(stored).sort()).toEqual([...Object.values(CONFIG_KEYS), CONFIG_SEEDED_AT].sort())
    expect(stored[CONFIG_KEYS.llmProvider]).toMatchObject({ value: 'claude', is_encrypted: false })
    expect(stored[CONFIG_KEYS.ownerNameTokens]?.value).toBe('["ALEX","SMITH"]')
    expect(stored[CONFIG_KEYS.syncIntervalHours]?.value).toBe('6')
    expect(stored[CONFIG_KEYS.schedulerEnabled]?.value).toBe('true')
    expect(stored[CONFIG_KEYS.anthropicApiKey]?.is_encrypted).toBe(true)
    expect(getSetting(db, secrets, CONFIG_KEYS.anthropicApiKey)).toBe(API_KEY)
    expect(rawValues(db)).not.toContain(API_KEY)
  })

  it('reports whether it seeded', () => {
    const db = makeDb()
    expect(seedConfig(db, secrets, defaults)).toBe(true)
    expect(seedConfig(db, secrets, defaults)).toBe(false)
  })

  it('seeds only once: afterwards the table wins over the environment', () => {
    const db = makeDb()
    runtimeConfig(db, secrets, defaults)
    const changed: RuntimeDefaults = {
      ...defaults,
      llmProvider: 'ollama',
      llmModel: 'llama3.1',
      syncIntervalHours: 12,
      schedulerEnabled: false,
    }
    expect(runtimeConfig(db, secrets, changed)).toMatchObject({
      llmProvider: 'claude',
      llmModel: 'claude-haiku-4-5',
      syncIntervalHours: 6,
      schedulerEnabled: true,
    })
  })

  it('does not seed a missing or blank API key', () => {
    for (const anthropicApiKey of [null, '', '   ']) {
      const db = makeDb()
      expect(runtimeConfig(db, secrets, { ...defaults, anthropicApiKey }).anthropicApiKeySet).toBe(false)
      expect(rows(db)[CONFIG_KEYS.anthropicApiKey]).toBeUndefined()
    }
  })

  it('keeps a cleared key cleared after a restart with the key still in the environment', () => {
    const db = makeDb()
    runtimeConfig(db, secrets, defaults)
    updateConfig(db, secrets, defaults, { anthropic_api_key: null })
    expect(runtimeConfig(db, secrets, defaults).anthropicApiKeySet).toBe(false)
    expect(llmSettings(db, secrets, defaults).anthropic_api_key).toBeNull()
  })

  it('reads the env default for a knob with no row', () => {
    const db = makeDb()
    runtimeConfig(db, secrets, defaults)
    db.delete(appSettings).where(eq(appSettings.key, CONFIG_KEYS.syncFirstHistoryDays)).run()
    expect(runtimeConfig(db, secrets, { ...defaults, syncFirstHistoryDays: 45 }).syncFirstHistoryDays).toBe(45)
  })

  it('seeds before an update, so the first update keeps the other env defaults', () => {
    const db = makeDb()
    updateConfig(db, secrets, defaults, { llm_model: 'claude-sonnet-4-5' })
    expect(runtimeConfig(db, secrets, { ...defaults, ownerNameTokens: [] })).toMatchObject({
      llmModel: 'claude-sonnet-4-5',
      ownerNameTokens: ['ALEX', 'SMITH'],
    })
  })

  it('seeds the test config defaults', () => {
    const config = testConfig()
    expect(runtimeConfig(makeDb(), secrets, config.defaults)).toMatchObject({
      llmProvider: 'fake',
      llmModel: 'claude-haiku-4-5',
      anthropicApiKeySet: false,
      schedulerEnabled: false,
      ownerNameTokens: [],
    })
  })
})

describe('updateConfig', () => {
  it('changes only the given fields and returns the new config', () => {
    const db = makeDb()
    const updated = updateConfig(db, secrets, defaults, {
      llm_provider: 'ollama',
      owner_name_tokens: ['JORDAN'],
      sync_interval_hours: 3,
      scheduler_enabled: false,
    })
    expect(updated).toEqual({
      llmProvider: 'ollama',
      llmModel: 'claude-haiku-4-5',
      anthropicApiKeySet: true,
      ollamaBaseUrl: 'http://localhost:11434',
      ownerNameTokens: ['JORDAN'],
      syncIntervalHours: 3,
      syncFirstHistoryDays: 180,
      schedulerEnabled: false,
    })
    expect(runtimeConfig(db, secrets, defaults)).toEqual(updated)
  })

  it('treats an empty update as a read', () => {
    const db = makeDb()
    expect(updateConfig(db, secrets, defaults, {})).toEqual(runtimeConfig(db, secrets, defaults))
  })

  it('stores a new API key encrypted and never in plain text', () => {
    const db = makeDb()
    const key = 'sk-ant-new-key-abcdef'
    updateConfig(db, secrets, { ...defaults, anthropicApiKey: null }, { anthropic_api_key: key })
    expect(rows(db)[CONFIG_KEYS.anthropicApiKey]?.is_encrypted).toBe(true)
    expect(rawValues(db)).not.toContain(key)
    expect(llmSettings(db, secrets, defaults).anthropic_api_key).toBe(key)
  })

  it('clears the key on null or blank, and leaves it alone when absent', () => {
    const db = makeDb()
    expect(updateConfig(db, secrets, defaults, { llm_model: 'm' }).anthropicApiKeySet).toBe(true)
    expect(updateConfig(db, secrets, defaults, { anthropic_api_key: null }).anthropicApiKeySet).toBe(false)
    updateConfig(db, secrets, defaults, { anthropic_api_key: API_KEY })
    expect(updateConfig(db, secrets, defaults, { anthropic_api_key: '  ' }).anthropicApiKeySet).toBe(false)
    expect(rows(db)[CONFIG_KEYS.anthropicApiKey]).toBeUndefined()
  })

  it('stores the key exactly as given', () => {
    const db = makeDb()
    updateConfig(db, secrets, defaults, { anthropic_api_key: ` ${API_KEY} ` })
    expect(llmSettings(db, secrets, defaults).anthropic_api_key).toBe(` ${API_KEY} `)
  })
})

describe('llmSettings', () => {
  it('returns exactly the LlmSettings shape the provider factory takes', () => {
    const db = makeDb()
    expect(llmSettings(db, secrets, defaults)).toStrictEqual({
      llm_provider: 'claude',
      llm_model: 'claude-haiku-4-5',
      anthropic_api_key: API_KEY,
      ollama_base_url: 'http://localhost:11434',
    })
  })

  it('reflects updates', () => {
    const db = makeDb()
    updateConfig(db, secrets, defaults, {
      llm_provider: 'ollama',
      llm_model: 'llama3.1',
      ollama_base_url: 'http://ollama.local:11434',
      anthropic_api_key: null,
    })
    expect(llmSettings(db, secrets, defaults)).toStrictEqual({
      llm_provider: 'ollama',
      llm_model: 'llama3.1',
      anthropic_api_key: null,
      ollama_base_url: 'http://ollama.local:11434',
    })
  })

  it('raises the app_settings DomainError when the secret key has changed', () => {
    const db = makeDb()
    runtimeConfig(db, secrets, defaults)
    expect(() => llmSettings(db, new KeySecretStore('rotated'), defaults)).toThrow(DomainError)
    // Reads that do not need the key still work.
    expect(runtimeConfig(db, new KeySecretStore('rotated'), defaults).anthropicApiKeySet).toBe(true)
  })
})

describe('llmStatus', () => {
  const status = (d: RuntimeDefaults) => llmStatus(makeDb(), secrets, d)

  it('is configured for fake and ollama, and for claude only with a non-blank key', () => {
    const fake = status({ ...defaults, llmProvider: 'fake', anthropicApiKey: null })
    expect(fake).toEqual({ provider: 'fake', model: 'claude-haiku-4-5', configured: true })
    const ollama = status({ ...defaults, llmProvider: 'ollama', llmModel: 'llama3.1', anthropicApiKey: null })
    expect(ollama).toEqual({ provider: 'ollama', model: 'llama3.1', configured: true })
    const noKey = status({ ...defaults, llmProvider: 'claude', anthropicApiKey: null })
    expect([noKey.provider, noKey.configured]).toEqual(['claude', false])
    const blank = status({ ...defaults, llmProvider: 'claude', anthropicApiKey: '  ' })
    expect(blank.configured).toBe(false)
    const keyed = status({ ...defaults, llmProvider: 'claude', anthropicApiKey: 'sk-test' })
    expect(keyed.configured).toBe(true)
    expect(JSON.stringify(keyed)).not.toContain('sk-test')
  })
})

describe('applyEnvOverrides (headless server only)', () => {
  it('writes the knobs whose variables are set, and only those', () => {
    const db = makeDb()
    updateConfig(db, secrets, defaults, { llm_model: 'from-ui', sync_interval_hours: 2 })
    const applied = applyEnvOverrides(db, secrets, {
      LLM_PROVIDER: 'ollama',
      sync_interval_hours: '12',
      OWNER_NAME_TOKENS: '["PAT"]',
      SCHEDULER_ENABLED: 'off',
      UNRELATED: 'x',
    })
    // Canonical variable names, never values.
    expect(applied.sort()).toEqual([
      'LLM_PROVIDER',
      'OWNER_NAME_TOKENS',
      'SCHEDULER_ENABLED',
      'SYNC_INTERVAL_HOURS',
    ])
    expect(runtimeConfig(db, secrets, defaults)).toMatchObject({
      llmProvider: 'ollama',
      llmModel: 'from-ui',
      syncIntervalHours: 12,
      ownerNameTokens: ['PAT'],
      schedulerEnabled: false,
    })
  })

  it('sets the API key encrypted, and a blank variable clears it', () => {
    const db = makeDb()
    runtimeConfig(db, secrets, { ...defaults, anthropicApiKey: null })
    applyEnvOverrides(db, secrets, { ANTHROPIC_API_KEY: API_KEY })
    expect(rawValues(db)).not.toContain(API_KEY)
    expect(llmSettings(db, secrets, defaults).anthropic_api_key).toBe(API_KEY)
    applyEnvOverrides(db, secrets, { ANTHROPIC_API_KEY: '' })
    expect(runtimeConfig(db, secrets, defaults).anthropicApiKeySet).toBe(false)
  })

  it('changes nothing with no variables set', () => {
    const db = makeDb()
    runtimeConfig(db, secrets, defaults)
    const before = rows(db)
    expect(applyEnvOverrides(db, secrets, {})).toEqual([])
    expect(rows(db)).toEqual(before)
  })

  it('refuses an invalid variable before writing anything', () => {
    const db = makeDb()
    runtimeConfig(db, secrets, defaults)
    const before = rows(db)
    expect(() => applyEnvOverrides(db, secrets, { LLM_MODEL: 'x', LLM_PROVIDER: 'openai' })).toThrow('LLM_PROVIDER')
    expect(rows(db)).toEqual(before)
  })

  it.each([
    ['SYNC_INTERVAL_HOURS', '0'],
    ['SYNC_FIRST_HISTORY_DAYS', '-1'],
  ])('refuses %s=%j below the Settings minimum before writing anything', (name, value) => {
    const db = makeDb()
    runtimeConfig(db, secrets, defaults)
    const before = rows(db)
    expect(() => applyEnvOverrides(db, secrets, { LLM_MODEL: 'x', [name]: value })).toThrow(
      `${name}="${value}" is invalid: expected an integer >= 1`,
    )
    expect(rows(db)).toEqual(before)
  })
})
