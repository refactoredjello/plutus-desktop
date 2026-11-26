import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig defaults', () => {
  const config = loadConfig({})

  it('has the documented defaults', () => {
    expect(config.environment).toBe('development')
    expect(config.secretKey).toBe('dev-only-change-me')
    expect(config.logLevel).toBe('info')
    expect(config.defaults).toEqual({
      llmProvider: 'fake',
      llmModel: 'claude-opus-5-5',
      anthropicApiKey: null,
      ollamaBaseUrl: 'http://localhost:11434',
      ownerNameTokens: [],
      syncIntervalHours: 6,
      syncFirstHistoryDays: 180,
      schedulerEnabled: true,
    })
  })

  it('keeps data in ~/.plutus with the database inside it', () => {
    expect(config.dataDir).toBe(join(homedir(), '.plutus'))
    expect(config.databasePath).toBe(join(homedir(), '.plutus', 'plutus.sqlite'))
  })

  it('has no pinned today and the API guard off', () => {
    expect(config.today).toBeNull()
    expect(config.apiGuard).toBe(false)
  })

  it('listens on loopback port 8000 and serves web/dist', () => {
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(8000)
    expect(config.webDist).toMatch(/web[/\\]dist$/)
  })
})

describe('loadConfig from the environment', () => {
  it('reads every knob', () => {
    const config = loadConfig({
      ENVIRONMENT: 'production',
      PLUTUS_DATA_DIR: '/tmp/plutus-data',
      PLUTUS_SECRET_KEY: 'k1',
      PLUTUS_TODAY: '2026-03-15',
      PLUTUS_WEB_DIST: '/srv/web',
      PLUTUS_API_GUARD: 'true',
      HOST: '0.0.0.0',
      PORT: '9001',
      LOG_LEVEL: 'debug',
      LLM_PROVIDER: 'claude',
      LLM_MODEL: 'claude-sonnet-4-5',
      ANTHROPIC_API_KEY: 'sk-test-fake',
      OLLAMA_BASE_URL: 'http://ollama:11434',
      OWNER_NAME_TOKENS: '["ALEX","SAMPLE"]',
      SYNC_INTERVAL_HOURS: '12',
      SYNC_FIRST_HISTORY_DAYS: '90',
      SCHEDULER_ENABLED: 'false',
      PLUTUS_ALLOWED_HOSTS: 'plutus.example.com',
    })
    expect(config).toEqual({
      environment: 'production',
      dataDir: '/tmp/plutus-data',
      databasePath: join('/tmp/plutus-data', 'plutus.sqlite'),
      secretKey: 'k1',
      today: '2026-03-15',
      webDist: '/srv/web',
      apiGuard: true,
      host: '0.0.0.0',
      allowedHosts: ['plutus.example.com'],
      port: 9001,
      logLevel: 'debug',
      defaults: {
        llmProvider: 'claude',
        llmModel: 'claude-sonnet-4-5',
        anthropicApiKey: 'sk-test-fake',
        ollamaBaseUrl: 'http://ollama:11434',
        ownerNameTokens: ['ALEX', 'SAMPLE'],
        syncIntervalHours: 12,
        syncFirstHistoryDays: 90,
        schedulerEnabled: false,
      },
    })
  })

  it('lets PLUTUS_DB_PATH override the database location', () => {
    expect(loadConfig({ PLUTUS_DB_PATH: ':memory:' }).databasePath).toBe(':memory:')
  })

  it('falls back to SECRET_KEY, preferring PLUTUS_SECRET_KEY', () => {
    expect(loadConfig({ SECRET_KEY: 'old' }).secretKey).toBe('old')
    expect(loadConfig({ SECRET_KEY: 'old', PLUTUS_SECRET_KEY: 'new' }).secretKey).toBe('new')
  })

  it('reads variable names case-insensitively', () => {
    expect(loadConfig({ llm_provider: 'ollama' }).defaults.llmProvider).toBe('ollama')
  })

  it.each(['1', 'true', 'TRUE', 'yes', 'on'])('reads %j as true', (value) => {
    expect(loadConfig({ SCHEDULER_ENABLED: value }).defaults.schedulerEnabled).toBe(true)
  })

  it.each(['0', 'false', 'False', 'no', 'off'])('reads %j as false', (value) => {
    expect(loadConfig({ SCHEDULER_ENABLED: value }).defaults.schedulerEnabled).toBe(false)
  })

  it.each([
    ['ENVIRONMENT', 'staging'],
    ['LLM_PROVIDER', 'openai'],
    ['SYNC_INTERVAL_HOURS', 'six'],
    ['SYNC_INTERVAL_HOURS', '1.5'],
    ['SCHEDULER_ENABLED', 'maybe'],
    ['OWNER_NAME_TOKENS', 'ALEX'],
    ['OWNER_NAME_TOKENS', '[1, 2]'],
    ['PLUTUS_TODAY', '2026-02-30'],
    ['PORT', '-1'],
  ])('refuses %s=%j', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name)
  })

  // The same minimum as ConfigUpdate in schemas/settings.ts, so a bad seed cannot get past
  // what Settings would refuse.
  it.each([
    ['SYNC_INTERVAL_HOURS', '0'],
    ['SYNC_INTERVAL_HOURS', '-3'],
    ['SYNC_INTERVAL_HOURS', '0.5'],
    ['SYNC_FIRST_HISTORY_DAYS', '0'],
    ['SYNC_FIRST_HISTORY_DAYS', '-30'],
    ['SYNC_FIRST_HISTORY_DAYS', '7.5'],
  ])('refuses %s=%j with a ConfigError naming the variable and the rule', (name, value) => {
    let error: unknown
    try {
      loadConfig({ [name]: value })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('ConfigError')
    expect((error as Error).message).toBe(`${name}=${JSON.stringify(value)} is invalid: expected an integer >= 1`)
  })

  it.each([
    ['SYNC_INTERVAL_HOURS', 'syncIntervalHours'],
    ['SYNC_FIRST_HISTORY_DAYS', 'syncFirstHistoryDays'],
  ] as const)('accepts %s=1, the minimum', (name, field) => {
    expect(loadConfig({ [name]: '1' }).defaults[field]).toBe(1)
  })
})
