/**
 * Runtime configuration from the environment. Ports app/config.py.
 *
 * The knobs under `defaults` seed app_settings on first run (plan section 5.7); the config
 * service in brief 1E owns reading them back. Dropped from the Python settings: DATABASE_URL
 * (replaced by the data directory), APP_PASSWORD_HASH (auth removed), CORS_ORIGINS (the SPA is
 * served from the same origin).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type PlainDate, isPlainDate } from './lib/dates.js'

export const ENVIRONMENTS = ['development', 'test', 'production'] as const
export type Environment = (typeof ENVIRONMENTS)[number]

export const LLM_PROVIDERS = ['claude', 'ollama', 'fake'] as const
export type LLMProviderName = (typeof LLM_PROVIDERS)[number]

/** Env defaults for the settings that move into app_settings. */
export interface RuntimeDefaults {
  llmProvider: LLMProviderName
  llmModel: string
  anthropicApiKey: string | null
  ollamaBaseUrl: string
  ownerNameTokens: string[]
  syncIntervalHours: number
  syncFirstHistoryDays: number
  schedulerEnabled: boolean
}

export interface Config {
  environment: Environment
  dataDir: string
  databasePath: string
  secretKey: string
  /** PLUTUS_TODAY, validated. lib/dates.today() reads the variable itself. */
  today: PlainDate | null
  webDist: string
  /** The per-launch cookie guard on /api (plan 5.9); off by default for the headless server. */
  apiGuard: boolean
  host: string
  port: number
  logLevel: string
  defaults: RuntimeDefaults
}

type Env = Record<string, string | undefined>

const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url))

class ConfigError extends Error {
  constructor(name: string, value: string, expected: string) {
    super(`${name}=${JSON.stringify(value)} is invalid: expected ${expected}`)
    this.name = 'ConfigError'
  }
}

/** pydantic-settings matches variable names case-insensitively. */
function reader(env: Env): (name: string) => string | undefined {
  const lower = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) lower.set(key.toLowerCase(), value)
  return (name) => env[name] ?? lower.get(name.toLowerCase())
}

const TRUE = new Set(['1', 'true', 't', 'yes', 'y', 'on'])
const FALSE = new Set(['0', 'false', 'f', 'no', 'n', 'off'])

function parseBool(name: string, value: string): boolean {
  const v = value.trim().toLowerCase()
  if (TRUE.has(v)) return true
  if (FALSE.has(v)) return false
  throw new ConfigError(name, value, 'a boolean')
}

function parseInt10(name: string, value: string, min = Number.MIN_SAFE_INTEGER): number {
  const v = value.trim()
  if (!/^[+-]?\d+$/.test(v)) throw new ConfigError(name, value, 'an integer')
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n < min) throw new ConfigError(name, value, `an integer >= ${min}`)
  return n
}

function parseChoice<T extends string>(name: string, value: string, choices: readonly T[]): T {
  if ((choices as readonly string[]).includes(value)) return value as T
  throw new ConfigError(name, value, `one of ${choices.join(', ')}`)
}

/** pydantic-settings parses list fields as JSON. */
function parseStringList(name: string, value: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new ConfigError(name, value, 'a JSON list of strings')
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new ConfigError(name, value, 'a JSON list of strings')
  }
  return parsed
}

export function loadConfig(env: Env = process.env): Config {
  const get = reader(env)
  const opt = <T>(name: string, parse: (name: string, value: string) => T, fallback: T): T => {
    const value = get(name)
    return value === undefined ? fallback : parse(name, value)
  }
  const str = (_name: string, value: string): string => value

  const dataDir = opt('PLUTUS_DATA_DIR', str, join(homedir(), '.plutus'))
  const today = opt(
    'PLUTUS_TODAY',
    (name, value) => {
      if (!isPlainDate(value)) throw new ConfigError(name, value, 'a YYYY-MM-DD date')
      return value
    },
    null as PlainDate | null,
  )

  return {
    environment: opt('ENVIRONMENT', (n, v) => parseChoice(n, v, ENVIRONMENTS), 'development'),
    dataDir,
    databasePath: opt('PLUTUS_DB_PATH', str, join(dataDir, 'plutus.sqlite')),
    secretKey: get('PLUTUS_SECRET_KEY') ?? get('SECRET_KEY') ?? 'dev-only-change-me',
    today,
    webDist: opt('PLUTUS_WEB_DIST', str, DEFAULT_WEB_DIST),
    apiGuard: opt('PLUTUS_API_GUARD', parseBool, false),
    host: opt('HOST', str, '127.0.0.1'),
    port: opt('PORT', (n, v) => parseInt10(n, v, 0), 8000),
    logLevel: opt('LOG_LEVEL', str, 'info'),
    defaults: {
      llmProvider: opt('LLM_PROVIDER', (n, v) => parseChoice(n, v, LLM_PROVIDERS), 'fake'),
      llmModel: opt('LLM_MODEL', str, 'claude-haiku-4-5'),
      anthropicApiKey: opt('ANTHROPIC_API_KEY', str, null as string | null),
      ollamaBaseUrl: opt('OLLAMA_BASE_URL', str, 'http://localhost:11434'),
      ownerNameTokens: opt('OWNER_NAME_TOKENS', parseStringList, []),
      syncIntervalHours: opt('SYNC_INTERVAL_HOURS', parseInt10, 6),
      // How far back the very first sync reaches. Each 45 days costs one SimpleFIN request.
      syncFirstHistoryDays: opt('SYNC_FIRST_HISTORY_DAYS', parseInt10, 180),
      schedulerEnabled: opt('SCHEDULER_ENABLED', parseBool, true),
    },
  }
}

export function jsonLogs(config: Config): boolean {
  return config.environment === 'production'
}
