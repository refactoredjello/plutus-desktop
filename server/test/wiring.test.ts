/**
 * Wiring: the LLM provider comes from the runtime config service, and connecting SimpleFIN
 * uses the real claim by default.
 */

import { describe, expect, it } from 'vitest'
import { ProviderError } from '../src/lib/errors.js'
import { KeySecretStore } from '../src/secrets.js'
import { llmProvider, updateConfig } from '../src/services/config.js'
import { makeApp, makeDb, testConfig } from './setup.js'

const config = testConfig()
const secrets = new KeySecretStore(config.secretKey)

describe('llmProvider: the factory reads the runtime config', () => {
  it('builds the fake provider by default in tests', () => {
    expect(llmProvider(makeDb(), secrets, config.defaults).name).toBe('fake')
  })

  it('builds Claude with the stored key and model', () => {
    const db = makeDb()
    updateConfig(db, secrets, config.defaults, {
      llm_provider: 'claude',
      llm_model: 'claude-test-model',
      anthropic_api_key: 'sk-ant-wiring-test',
    })
    const provider = llmProvider(db, secrets, config.defaults)
    expect(provider.name).toBe('claude')
    expect((provider as unknown as { model: string }).model).toBe('claude-test-model')
  })

  it('refuses Claude without a key', () => {
    const db = makeDb()
    updateConfig(db, secrets, config.defaults, { llm_provider: 'claude', anthropic_api_key: null })
    expect(() => llmProvider(db, secrets, config.defaults)).toThrow(ProviderError)
  })

  it('builds Ollama at the stored URL', () => {
    const db = makeDb()
    updateConfig(db, secrets, config.defaults, { llm_provider: 'ollama', ollama_base_url: 'http://ollama.test:11434' })
    expect(llmProvider(db, secrets, config.defaults).name).toBe('ollama')
  })
})

describe('POST /api/settings/simplefin uses the real claim', () => {
  it('rejects a token that holds no claim URL as an upstream provider error, without the network', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/settings/simplefin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setup_token: 'fake-setup-token' }),
    })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { title: string }).title).toBe('Upstream provider error')
  })
})
