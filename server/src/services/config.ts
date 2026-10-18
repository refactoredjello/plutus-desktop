/**
 * Runtime config: the knobs kept in app_settings so the desktop can change them at run time.
 * The rest of the server reads these through this module, never env.
 *
 * The rule:
 * - Seeding. The first time the config is read or updated, every knob without a row is written
 *   from the env defaults (`Config.defaults`, which loadConfig fills from the environment or its
 *   own fallbacks), then a `config_seeded_at` row marks the database seeded. Seeding never runs
 *   again: later env changes do not reach the table, and a key the user cleared stays cleared.
 * - Reads. The table wins. A knob with no row (one added after seeding) reads its env default,
 *   except the API key: no row means no key.
 * - Headless override. `applyEnvOverrides(db, secrets, env)` writes every knob whose variable is
 *   set in `env`. The headless server calls it at start, so a set variable wins at every start
 *   and a PUT holds until the next one. The desktop never calls it and reads only the table.
 * - The Anthropic API key is stored encrypted through the SecretStore and is write-only: reads
 *   say only whether it is set. A blank key means none, so storing a blank key clears it.
 */

import { type LLMProviderName, LLM_PROVIDERS, type RuntimeDefaults, loadConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { appSettings } from '../db/schema.js'
import { utcNow } from '../lib/dates.js'
import type { Logger } from '../lib/log.js'
import { type LlmSettings, getLlmProvider } from '../providers/llm/index.js'
import type { LLMProvider } from '../providers/llm/types.js'
import type { SecretStore } from '../secrets.js'
import { deleteSetting, getSetting, setSetting } from './app_settings.js'

/** The app_settings key of each knob: the field name in ConfigRead and ConfigUpdate. */
export const CONFIG_KEYS = {
  llmProvider: 'llm_provider',
  llmModel: 'llm_model',
  anthropicApiKey: 'anthropic_api_key',
  ollamaBaseUrl: 'ollama_base_url',
  ownerNameTokens: 'owner_name_tokens',
  syncIntervalHours: 'sync_interval_hours',
  syncFirstHistoryDays: 'sync_first_history_days',
  schedulerEnabled: 'scheduler_enabled',
} as const satisfies Record<keyof RuntimeDefaults, string>

/** Marks a database whose config has been seeded from the env defaults. */
export const CONFIG_SEEDED_AT = 'config_seeded_at'

/** The environment variable of each knob, as loadConfig names it. */
const ENV_NAMES: Record<keyof RuntimeDefaults, string> = {
  llmProvider: 'LLM_PROVIDER',
  llmModel: 'LLM_MODEL',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  ollamaBaseUrl: 'OLLAMA_BASE_URL',
  ownerNameTokens: 'OWNER_NAME_TOKENS',
  syncIntervalHours: 'SYNC_INTERVAL_HOURS',
  syncFirstHistoryDays: 'SYNC_FIRST_HISTORY_DAYS',
  schedulerEnabled: 'SCHEDULER_ENABLED',
}

/** The config the server runs with. The API key itself is only in `llmSettings`. */
export interface RuntimeConfig {
  llmProvider: LLMProviderName
  llmModel: string
  anthropicApiKeySet: boolean
  ollamaBaseUrl: string
  ownerNameTokens: string[]
  syncIntervalHours: number
  syncFirstHistoryDays: number
  schedulerEnabled: boolean
}

export type { LlmSettings }

/** What GET /settings/llm reports (LLMStatus). */
export interface LlmStatus {
  provider: string
  model: string
  configured: boolean
}

/** A partial update, shaped like ConfigUpdate. `anthropic_api_key: null` clears the key. */
export interface ConfigChanges {
  llm_provider?: LLMProviderName | undefined
  llm_model?: string | undefined
  anthropic_api_key?: string | null | undefined
  ollama_base_url?: string | undefined
  owner_name_tokens?: string[] | undefined
  sync_interval_hours?: number | undefined
  sync_first_history_days?: number | undefined
  scheduler_enabled?: boolean | undefined
}

type Knob = Exclude<keyof RuntimeDefaults, 'anthropicApiKey'>

interface Codec<T> {
  encode(value: T): string
  decode(raw: string): T | undefined
}

const text: Codec<string> = { encode: (v) => v, decode: (raw) => raw }
const integer: Codec<number> = {
  encode: (v) => String(v),
  decode: (raw) => (/^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined),
}
const boolean: Codec<boolean> = {
  encode: (v) => String(v),
  decode: (raw) => (raw === 'true' ? true : raw === 'false' ? false : undefined),
}
const provider: Codec<LLMProviderName> = {
  encode: (v) => v,
  decode: (raw) => LLM_PROVIDERS.find((p) => p === raw),
}
const stringList: Codec<string[]> = {
  encode: (v) => JSON.stringify(v),
  decode: (raw) => {
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) && parsed.every((t) => typeof t === 'string') ? parsed : undefined
    } catch {
      return undefined
    }
  },
}

const CODECS: { [K in Knob]: Codec<RuntimeDefaults[K]> } = {
  llmProvider: provider,
  llmModel: text,
  ollamaBaseUrl: text,
  ownerNameTokens: stringList,
  syncIntervalHours: integer,
  syncFirstHistoryDays: integer,
  schedulerEnabled: boolean,
}

const KNOBS = Object.keys(CODECS) as Knob[]

function storedRows(db: Db): Map<string, string> {
  return new Map(db.select().from(appSettings).all().map((row) => [row.key, row.value]))
}

function writeKnob<K extends Knob>(db: Db, secrets: SecretStore, knob: K, value: RuntimeDefaults[K]): void {
  setSetting(db, secrets, CONFIG_KEYS[knob], CODECS[knob].encode(value))
}

/** Store the key encrypted; null or blank clears it. */
function writeApiKey(db: Db, secrets: SecretStore, key: string | null): void {
  if (key === null || key.trim() === '') deleteSetting(db, CONFIG_KEYS.anthropicApiKey)
  else setSetting(db, secrets, CONFIG_KEYS.anthropicApiKey, key, { encrypt: true })
}

function readKnob<K extends Knob>(stored: Map<string, string>, defaults: RuntimeDefaults, knob: K): RuntimeDefaults[K] {
  const raw = stored.get(CONFIG_KEYS[knob])
  if (raw === undefined) return defaults[knob]
  const value = CODECS[knob].decode(raw)
  if (value === undefined) throw new Error(`Stored setting '${CONFIG_KEYS[knob]}' is invalid`)
  return value
}

/** Seed every missing knob from the env defaults, once per database. True when it seeded. */
export function seedConfig(db: Db, secrets: SecretStore, defaults: RuntimeDefaults): boolean {
  const stored = storedRows(db)
  if (stored.has(CONFIG_SEEDED_AT)) return false
  for (const knob of KNOBS) {
    if (!stored.has(CONFIG_KEYS[knob])) writeKnob(db, secrets, knob, defaults[knob])
  }
  if (!stored.has(CONFIG_KEYS.anthropicApiKey)) writeApiKey(db, secrets, defaults.anthropicApiKey)
  setSetting(db, secrets, CONFIG_SEEDED_AT, utcNow())
  return true
}

export function runtimeConfig(db: Db, secrets: SecretStore, defaults: RuntimeDefaults): RuntimeConfig {
  seedConfig(db, secrets, defaults)
  const stored = storedRows(db)
  const read = <K extends Knob>(knob: K) => readKnob(stored, defaults, knob)
  return {
    llmProvider: read('llmProvider'),
    llmModel: read('llmModel'),
    anthropicApiKeySet: stored.has(CONFIG_KEYS.anthropicApiKey),
    ollamaBaseUrl: read('ollamaBaseUrl'),
    ownerNameTokens: read('ownerNameTokens'),
    syncIntervalHours: read('syncIntervalHours'),
    syncFirstHistoryDays: read('syncFirstHistoryDays'),
    schedulerEnabled: read('schedulerEnabled'),
  }
}

export function updateConfig(
  db: Db,
  secrets: SecretStore,
  defaults: RuntimeDefaults,
  changes: ConfigChanges,
): RuntimeConfig {
  seedConfig(db, secrets, defaults)
  const given: { [K in Knob]: RuntimeDefaults[K] | undefined } = {
    llmProvider: changes.llm_provider,
    llmModel: changes.llm_model,
    ollamaBaseUrl: changes.ollama_base_url,
    ownerNameTokens: changes.owner_name_tokens,
    syncIntervalHours: changes.sync_interval_hours,
    syncFirstHistoryDays: changes.sync_first_history_days,
    schedulerEnabled: changes.scheduler_enabled,
  }
  for (const knob of KNOBS) {
    const value = given[knob]
    if (value !== undefined) writeKnob(db, secrets, knob, value)
  }
  if (changes.anthropic_api_key !== undefined) writeApiKey(db, secrets, changes.anthropic_api_key)
  return runtimeConfig(db, secrets, defaults)
}

/** The settings the LLM provider factory takes. Decrypts the API key. */
export function llmSettings(db: Db, secrets: SecretStore, defaults: RuntimeDefaults): LlmSettings {
  const config = runtimeConfig(db, secrets, defaults)
  return {
    llm_provider: config.llmProvider,
    llm_model: config.llmModel,
    anthropic_api_key: getSetting(db, secrets, CONFIG_KEYS.anthropicApiKey),
    ollama_base_url: config.ollamaBaseUrl,
  }
}

/** The LLM provider the runtime config names: the one way services get a provider. */
export function llmProvider(db: Db, secrets: SecretStore, defaults: RuntimeDefaults, log?: Logger): LLMProvider {
  return getLlmProvider(llmSettings(db, secrets, defaults), log)
}

/** The LLM status: Claude is configured only with a non-blank key. */
export function llmStatus(db: Db, secrets: SecretStore, defaults: RuntimeDefaults): LlmStatus {
  const config = runtimeConfig(db, secrets, defaults)
  return {
    provider: config.llmProvider,
    model: config.llmModel,
    configured: config.llmProvider !== 'claude' || config.anthropicApiKeySet,
  }
}

/**
 * Headless server only: write every knob whose variable is set in `env` (matched
 * case-insensitively, parsed by loadConfig). Returns the variable names applied, never values.
 * Throws before writing anything if a variable is invalid.
 */
export function applyEnvOverrides(
  db: Db,
  secrets: SecretStore,
  env: Record<string, string | undefined>,
): string[] {
  const parsed = loadConfig(env).defaults
  const present = new Set(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name.toUpperCase()),
  )
  const applied: string[] = []
  for (const knob of KNOBS) {
    if (!present.has(ENV_NAMES[knob])) continue
    writeKnob(db, secrets, knob, parsed[knob])
    applied.push(ENV_NAMES[knob])
  }
  if (present.has(ENV_NAMES.anthropicApiKey)) {
    writeApiKey(db, secrets, parsed.anthropicApiKey)
    applied.push(ENV_NAMES.anthropicApiKey)
  }
  return applied
}
