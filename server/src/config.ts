/**
 * Runtime configuration from the environment.
 *
 * The knobs under `defaults` seed app_settings on first run; services/config.ts owns reading
 * them back. There is no database URL (the data directory decides), no password (single user,
 * loopback), and no CORS setting (the SPA is served from the same origin).
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
  /** The per-launch cookie guard on /api; off by default for the headless server. */
  apiGuard: boolean
  host: string
  /** PLUTUS_ALLOWED_HOSTS: extra names the Host header may carry, lower case (app.ts hostCheck). */
  allowedHosts: string[]
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

/** Variable names match case-insensitively. */
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

function parseInt10(name: string, value: string, min?: number): number {
  const expected = min === undefined ? 'an integer' : `an integer >= ${min}`
  const v = value.trim()
  if (!/^[+-]?\d+$/.test(v)) throw new ConfigError(name, value, expected)
  const n = Number(v)
  if (!Number.isSafeInteger(n) || (min !== undefined && n < min)) throw new ConfigError(name, value, expected)
  return n
}

/** Integers Settings bounds with `.min(1)` (ConfigUpdate in schemas/settings.ts). */
const positiveInt = (name: string, value: string): number => parseInt10(name, value, 1)

function parseChoice<T extends string>(name: string, value: string, choices: readonly T[]): T {
  if ((choices as readonly string[]).includes(value)) return value as T
  throw new ConfigError(name, value, `one of ${choices.join(', ')}`)
}

/** List variables are JSON arrays. */
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

/** A comma-separated list of host names, trimmed and lower-cased. */
function parseHostList(_name: string, value: string): string[] {
  return value
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '')
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
    allowedHosts: opt('PLUTUS_ALLOWED_HOSTS', parseHostList, []),
    port: opt('PORT', (n, v) => parseInt10(n, v, 0), 8000),
    logLevel: opt('LOG_LEVEL', str, 'info'),
    defaults: {
      llmProvider: opt('LLM_PROVIDER', (n, v) => parseChoice(n, v, LLM_PROVIDERS), 'fake'),
      llmModel: opt('LLM_MODEL', str, 'claude-opus-5-5'),
      anthropicApiKey: opt('ANTHROPIC_API_KEY', str, null as string | null),
      ollamaBaseUrl: opt('OLLAMA_BASE_URL', str, 'http://localhost:11434'),
      ownerNameTokens: opt('OWNER_NAME_TOKENS', parseStringList, []),
      syncIntervalHours: opt('SYNC_INTERVAL_HOURS', positiveInt, 6),
      // How far back the very first sync reaches. Each 45 days costs one SimpleFIN request.
      syncFirstHistoryDays: opt('SYNC_FIRST_HISTORY_DAYS', positiveInt, 180),
      schedulerEnabled: opt('SCHEDULER_ENABLED', parseBool, true),
    },
  }
}
