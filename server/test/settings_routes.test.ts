/**
 * Settings routes: SimpleFIN status, connect (a bad token is 502), and disconnect; the LLM
 * status; the GET/PUT /api/settings/config contract; and the privacy guarantees: the access
 * URL and the API key are never returned and never logged.
 *
 * SimpleFIN's claim is swapped for a fake: it decodes the token
 * and answers with ACCESS_URL. test/wiring.test.ts covers the real claim's default.
 */

import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import type { RuntimeDefaults } from '../src/config.js'
import { ProviderError } from '../src/lib/errors.js'
import { createLogger, silentLogger } from '../src/lib/log.js'
import { simplefinClaim } from '../src/routes/settings.js'
import { OVERDUE_DELAY_MS, type Scheduler, createScheduler } from '../src/scheduler.js'
import { KeySecretStore, SecretDecryptError } from '../src/secrets.js'
import { runtimeConfig } from '../src/services/config.js'
import { ACCESS_URL, makeToken } from './factories.js'
import { makeApp, makeDb, testConfig } from './setup.js'

const API_KEY = 'sk-ant-route-test-987654'

/** claim_setup_token's input checks over a mocked bridge that answers ACCESS_URL. */
async function fakeClaim(token: string): Promise<string> {
  const claimUrl = Buffer.from(token.trim(), 'base64').toString('utf8')
  if (!/^https?:\/\//.test(claimUrl)) {
    throw new ProviderError('The SimpleFIN setup token does not contain a claim URL.')
  }
  return ACCESS_URL
}

const claims: string[] = []

beforeEach(() => {
  claims.length = 0
  vi.spyOn(simplefinClaim, 'claim').mockImplementation(async (token) => {
    claims.push(token)
    return fakeClaim(token)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

type Body = Record<string, unknown>

async function body(r: Response): Promise<Body> {
  return (await r.json()) as Body
}

function send(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
}

function appWith(defaults: Partial<RuntimeDefaults> = {}) {
  const config = testConfig()
  return makeApp({ config: { ...config, defaults: { ...config.defaults, ...defaults } } })
}

describe('SimpleFIN connection', () => {
  it('reports status, connects, and disconnects', async () => {
    const { app } = makeApp()
    expect(await body(await app.request('/api/settings/simplefin'))).toEqual({
      connected: false,
      connected_at: null,
    })
    const r = await app.request('/api/settings/simplefin', send('POST', { setup_token: makeToken() }))
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(JSON.parse(text).connected).toBe(true)
    expect(text).not.toContain('pass456')
    expect(claims).toEqual([makeToken()])
    const status = await body(await app.request('/api/settings/simplefin'))
    expect(status.connected).toBe(true)
    expect(status.connected_at).toBeTruthy()
    expect(status.connected_at).toBe(JSON.parse(text).connected_at)
    expect((await app.request('/api/settings/simplefin', send('DELETE'))).status).toBe(204)
    expect((await body(await app.request('/api/settings/simplefin'))).connected).toBe(false)
  })

  it('answers 502 for a bad token', async () => {
    const { app } = makeApp()
    const r = await app.request('/api/settings/simplefin', send('POST', { setup_token: '%%%' }))
    expect(r.status).toBe(502)
    expect(r.headers.get('content-type')).toBe('application/problem+json')
    expect((await body(await app.request('/api/settings/simplefin'))).connected).toBe(false)
  })

  // Backlog 13 (fixed): an unreadable access URL still reports connected, with 200.
  it('reports connected with 200 when the stored access URL cannot be decrypted', async () => {
    const config = testConfig()
    const db = makeDb()
    await makeApp({ db, config }).app.request(
      '/api/settings/simplefin',
      send('POST', { setup_token: makeToken() }),
    )
    const working = await body(await makeApp({ db, config }).app.request('/api/settings/simplefin'))
    expect(working.connected).toBe(true)
    const real = new KeySecretStore(config.secretKey)
    const locked = {
      encrypt: (plain: string) => real.encrypt(plain),
      decrypt: (): string => {
        throw new SecretDecryptError()
      },
    }
    const r = await makeApp({ db, config, secrets: locked }).app.request('/api/settings/simplefin')
    expect(r.status).toBe(200)
    expect(await body(r)).toEqual({ connected: true, connected_at: working.connected_at })
    const empty = await makeApp({ config, secrets: locked }).app.request('/api/settings/simplefin')
    expect(empty.status).toBe(200)
    expect(await body(empty)).toEqual({ connected: false, connected_at: null })
  })

  it('disconnecting when not connected is still 204', async () => {
    const { app } = makeApp()
    const r = await app.request('/api/settings/simplefin', send('DELETE'))
    expect(r.status).toBe(204)
    expect(await r.text()).toBe('')
  })
})

describe('GET /api/settings/llm', () => {
  const llmStatus = async (defaults: Partial<RuntimeDefaults>) =>
    body(await appWith(defaults).app.request('/api/settings/llm'))

  it('reports provider, model, and whether it is configured', async () => {
    expect(await llmStatus({ llmProvider: 'fake' })).toEqual({
      provider: 'fake',
      model: 'claude-opus-5-5',
      configured: true,
    })
    expect(await llmStatus({ llmProvider: 'ollama', llmModel: 'llama3.1' })).toEqual({
      provider: 'ollama',
      model: 'llama3.1',
      configured: true,
    })
    const noKey = await llmStatus({ llmProvider: 'claude', anthropicApiKey: null })
    expect([noKey.provider, noKey.configured]).toEqual(['claude', false])
    const keyed = await llmStatus({ llmProvider: 'claude', anthropicApiKey: 'sk-test' })
    expect(keyed.configured).toBe(true)
    expect(JSON.stringify(keyed)).not.toContain('sk-test')
  })

  it('follows config updates', async () => {
    const { app } = makeApp()
    await app.request('/api/settings/config', send('PUT', { llm_provider: 'claude' }))
    expect((await body(await app.request('/api/settings/llm'))).configured).toBe(false)
    await app.request('/api/settings/config', send('PUT', { anthropic_api_key: API_KEY }))
    expect(await body(await app.request('/api/settings/llm'))).toEqual({
      provider: 'claude',
      model: 'claude-opus-5-5',
      configured: true,
    })
  })
})

describe('/api/settings/config', () => {
  it('reads the seeded test config', async () => {
    const { app } = makeApp()
    const r = await app.request('/api/settings/config')
    expect(r.status).toBe(200)
    expect(await body(r)).toEqual({
      llm_provider: 'fake',
      llm_model: 'claude-opus-5-5',
      anthropic_api_key_set: false,
      ollama_base_url: 'http://localhost:11434',
      owner_name_tokens: [],
      sync_interval_hours: 6,
      sync_first_history_days: 180,
      scheduler_enabled: false,
    })
  })

  it('updates only the given fields and returns the new config', async () => {
    const { app } = makeApp()
    const r = await app.request(
      '/api/settings/config',
      send('PUT', {
        llm_provider: 'ollama',
        llm_model: 'llama3.1',
        owner_name_tokens: ['ALEX'],
        sync_first_history_days: 90,
        scheduler_enabled: true,
      }),
    )
    expect(r.status).toBe(200)
    const expected = {
      llm_provider: 'ollama',
      llm_model: 'llama3.1',
      anthropic_api_key_set: false,
      ollama_base_url: 'http://localhost:11434',
      owner_name_tokens: ['ALEX'],
      sync_interval_hours: 6,
      sync_first_history_days: 90,
      scheduler_enabled: true,
    }
    expect(await body(r)).toEqual(expected)
    expect(await body(await app.request('/api/settings/config'))).toEqual(expected)
  })

  it('sets and clears the API key without ever returning it', async () => {
    const { app } = makeApp()
    const set = await app.request('/api/settings/config', send('PUT', { anthropic_api_key: API_KEY }))
    const setText = await set.text()
    expect(JSON.parse(setText).anthropic_api_key_set).toBe(true)
    expect(setText).not.toContain(API_KEY)
    expect(JSON.parse(setText)).not.toHaveProperty('anthropic_api_key')
    const read = await (await app.request('/api/settings/config')).text()
    expect(read).not.toContain(API_KEY)
    expect(JSON.parse(read).anthropic_api_key_set).toBe(true)
    const cleared = await app.request('/api/settings/config', send('PUT', { anthropic_api_key: null }))
    expect((await body(cleared)).anthropic_api_key_set).toBe(false)
  })

  it('accepts an empty update', async () => {
    const { app } = makeApp()
    const r = await app.request('/api/settings/config', send('PUT', {}))
    expect(r.status).toBe(200)
    expect((await body(r)).llm_provider).toBe('fake')
  })
})

describe('privacy: secrets are never returned or logged', () => {
  function capture() {
    const chunks: string[] = []
    const stream = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk))
        done()
      },
    })
    return { log: createLogger({ level: 'debug' }, stream), text: () => chunks.join('') }
  }

  it('keeps the access URL and the API key out of every response, the database, and the log', async () => {
    const out = capture()
    const config = testConfig()
    const { app, db } = makeApp({
      config: { ...config, defaults: { ...config.defaults, llmProvider: 'claude', anthropicApiKey: API_KEY } },
      log: out.log,
    })
    const bodies: string[] = []
    const call = async (url: string, init?: RequestInit) => {
      const r = await app.request(url, init)
      bodies.push(await r.text(), JSON.stringify([...r.headers]))
      return r
    }
    await call('/api/settings/config')
    await call('/api/settings/llm')
    await call('/api/settings/simplefin', send('POST', { setup_token: makeToken() }))
    await call('/api/settings/simplefin')
    await call('/api/settings/config', send('PUT', { anthropic_api_key: `${API_KEY}-2`, llm_model: 'x' }))
    await call('/api/settings/config')
    await call('/api/settings/simplefin', send('POST', { setup_token: '%%%' }))
    // An unexpected failure reaches the error handler's log.
    vi.mocked(simplefinClaim.claim).mockRejectedValueOnce(new Error('bridge exploded'))
    expect((await call('/api/settings/simplefin', send('POST', { setup_token: makeToken() }))).status).toBe(500)

    const logged = out.text()
    expect(logged).toContain('bridge exploded')
    const stored = JSON.stringify(db.$client.prepare('select * from app_settings').all())
    for (const text of [bodies.join('\n'), logged, stored]) {
      expect(text).not.toContain(API_KEY)
      expect(text).not.toContain(ACCESS_URL)
      expect(text).not.toContain('pass456')
    }
  })
})

describe('PUT /api/settings/config reschedules (backlog 31)', () => {
  const NOW = new Date('2026-10-03T12:00:00.000Z')

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reschedules after storing the change, once per update', async () => {
    const config = testConfig()
    const db = makeDb()
    const secrets = new KeySecretStore(config.secretKey)
    const seen: boolean[] = []
    const scheduler = {
      nextRunAt: () => null,
      reschedule: vi.fn(() => {
        seen.push(runtimeConfig(db, secrets, config.defaults).schedulerEnabled)
      }),
    }
    const app = createApp({ db, secrets, config, log: silentLogger(), scheduler })
    await app.request('/api/settings/config', send('PUT', { scheduler_enabled: true }))
    await app.request('/api/settings/config', send('PUT', { scheduler_enabled: false }))
    expect(seen).toEqual([true, false])
    // A rejected update stores nothing and reschedules nothing.
    expect((await app.request('/api/settings/config', send('PUT', { sync_interval_hours: 'x' }))).status).toBe(422)
    expect(scheduler.reschedule).toHaveBeenCalledTimes(2)
  })

  it('GET /api/sync/schedule and the real timer agree after turning it on and off', async () => {
    vi.useFakeTimers({ now: NOW })
    const config = testConfig() // scheduler disabled at start
    const db = makeDb()
    const secrets = new KeySecretStore(config.secretKey)
    const job = vi.fn(async () => {})
    const scheduler: Scheduler = createScheduler({ db, secrets, defaults: config.defaults, random: () => 0, job })
    const app = createApp({ db, secrets, config, log: silentLogger(), scheduler })
    const schedule = async () => body(await app.request('/api/sync/schedule'))
    try {
      expect(scheduler.start()).toBe(false)
      expect(await schedule()).toEqual({ enabled: false, interval_hours: 6, next_run_at: null })

      await app.request('/api/settings/config', send('PUT', { scheduler_enabled: true, sync_interval_hours: 2 }))
      const due = new Date(NOW.getTime() + OVERDUE_DELAY_MS).toISOString()
      expect(await schedule()).toEqual({ enabled: true, interval_hours: 2, next_run_at: due })
      expect(scheduler.nextRunAt()).toBe(due)
      await vi.advanceTimersByTimeAsync(OVERDUE_DELAY_MS)
      expect(job).toHaveBeenCalledTimes(1)
      expect((await schedule()).next_run_at).toBe(new Date(Date.parse(due) + 2 * 3_600_000).toISOString())

      await app.request('/api/settings/config', send('PUT', { scheduler_enabled: false }))
      expect(await schedule()).toEqual({ enabled: false, interval_hours: 2, next_run_at: null })
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(10 * 3_600_000)
      expect(job).toHaveBeenCalledTimes(1)
    } finally {
      scheduler.stop()
    }
  })
})
