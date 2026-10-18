import { describe, expect, it } from 'vitest'
import { CONFIG_PATH, configCheck, expectedConfig } from './config_check.ts'

const ENV = {
  LLM_PROVIDER: 'fake',
  OWNER_NAME_TOKENS: '["ALEX","SAMPLE"]',
  SCHEDULER_ENABLED: 'false',
  SYNC_INTERVAL_HOURS: '6',
  SYNC_FIRST_HISTORY_DAYS: '180',
}
const LLM = { provider: 'fake', model: 'claude-haiku-4-5', configured: true }
const SCHEDULE = { enabled: false, interval_hours: 6, next_run_at: null }

const EXPECTED = {
  llm_provider: 'fake',
  llm_model: 'claude-haiku-4-5',
  anthropic_api_key_set: false,
  ollama_base_url: 'http://localhost:11434',
  owner_name_tokens: ['ALEX', 'SAMPLE'],
  sync_interval_hours: 6,
  sync_first_history_days: 180,
  scheduler_enabled: false,
}

describe('expectedConfig', () => {
  it('derives the runtime config from the env both apps got and the oracle\'s own answers', () => {
    expect(CONFIG_PATH).toBe('/api/settings/config')
    expect(expectedConfig(ENV, LLM, SCHEDULE)).toEqual(EXPECTED)
  })

  it('reads the optional knobs from the env when set', () => {
    const env = { ...ENV, ANTHROPIC_API_KEY: 'x', OLLAMA_BASE_URL: 'http://127.0.0.1:1', OWNER_NAME_TOKENS: '[]', SYNC_FIRST_HISTORY_DAYS: '45' }
    expect(expectedConfig(env, LLM, SCHEDULE)).toMatchObject({
      anthropic_api_key_set: true,
      ollama_base_url: 'http://127.0.0.1:1',
      owner_name_tokens: [],
      sync_first_history_days: 45,
    })
  })

  it('returns null when an oracle answer is not the shape it expects', () => {
    expect(expectedConfig(ENV, { provider: 'fake' }, SCHEDULE)).toBeNull()
    expect(expectedConfig(ENV, LLM, 'nope')).toBeNull()
  })
})

describe('configCheck', () => {
  it('passes when the TypeScript answer equals the expected config', () => {
    const r = configCheck(EXPECTED, { status: 200, contentType: 'application/json', body: { ...EXPECTED } })
    expect(r).toEqual({ name: 'runtime config (TypeScript only)', ok: true, detail: `GET ${CONFIG_PATH} matches the seeded env` })
  })

  it('names each differing field', () => {
    const r = configCheck(EXPECTED, {
      status: 200,
      contentType: 'application/json',
      body: { ...EXPECTED, owner_name_tokens: ['ALEX'], scheduler_enabled: true },
    })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('owner_name_tokens: expected ["ALEX","SAMPLE"], got ["ALEX"]')
    expect(r.detail).toContain('scheduler_enabled: expected false, got true')
  })

  it('fails on a non-200 answer or a missing expectation', () => {
    expect(configCheck(EXPECTED, { status: 404, contentType: 'application/json', body: null }).detail).toContain('404')
    expect(configCheck(null, { status: 200, contentType: 'application/json', body: EXPECTED }).ok).toBe(false)
  })
})
