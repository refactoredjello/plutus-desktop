/**
 * The sync routes. The SimpleFIN settings tests live in test/settings_routes.test.ts and the
 * empty accounts list in test/accounts.test.ts.
 *
 * The claim is the settings route's hook, answering with ACCESS_URL, and the provider's fetch
 * is the global fetch, stubbed to answer /accounts with the fixture. A test awaits
 * `backgroundSyncsSettled()` for the run POST /api/sync starts.
 *
 * The last block: the 202 answers before the run finishes, and the detached run records its
 * own failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backgroundSyncsSettled } from '../src/routes/sync.js'
import { simplefinClaim } from '../src/routes/settings.js'
import { KeySecretStore } from '../src/secrets.js'
import * as sync from '../src/services/sync.js'
import { ACCESS_URL, loadFixture, makeToken, mockFetch } from './factories.js'
import { makeApp } from './setup.js'

type Body = Record<string, unknown>

let ctx: ReturnType<typeof makeApp>

beforeEach(() => {
  ctx = makeApp()
  vi.spyOn(simplefinClaim, 'claim').mockResolvedValue(ACCESS_URL)
  vi.stubGlobal('fetch', mockFetch())
})

afterEach(async () => {
  await backgroundSyncsSettled()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const get = async (path: string) => (await ctx.app.request(path)).json() as Promise<Body>
const post = (path: string) => ctx.app.request(path, { method: 'POST' })

async function connect(): Promise<void> {
  const r = await ctx.app.request('/api/settings/simplefin', {
    method: 'POST',
    body: JSON.stringify({ setup_token: makeToken() }),
    headers: { 'Content-Type': 'application/json' },
  })
  expect(r.status, await r.clone().text()).toBe(200)
}

describe('sync routes', () => {
  it('sync requires connection', async () => {
    expect((await post('/api/sync')).status).toBe(400)
  })

  it('sync happy path and runs', async () => {
    await connect()
    const r = await post('/api/sync')
    expect(r.status).toBe(202)
    const started = (await r.json()) as Body
    const runId = started.id
    expect(started.trigger).toBe('manual')

    await backgroundSyncsSettled()
    const done = await get(`/api/sync/runs/${runId}`)
    expect(done.status).toBe('success')
    expect(done.added).toBe(295)

    const runs = (await (await ctx.app.request('/api/sync/runs')).json()) as Body[]
    expect(runs.map((x) => x.id)).toEqual([runId])

    const accounts = (await (await ctx.app.request('/api/accounts')).json()) as Body[]
    expect(accounts).toHaveLength(3)
    const visa = accounts.find((a) => a.name === 'Rewards Visa')
    expect(visa?.type).toBe('credit')
    expect(visa?.balance).toBe('-842.17')
    expect(visa?.available).toBe('7157.83')
    expect(visa?.balance_as_of).toBeTruthy()
  })

  it('sync conflict when running', async () => {
    await connect()
    sync.startRun(ctx.db, new KeySecretStore(ctx.config.secretKey), ctx.config.defaults, 'simplefin', 'manual')
    const r = await post('/api/sync')
    expect(r.status).toBe(409)
  })

  it('run not found', async () => {
    expect((await ctx.app.request('/api/sync/runs/999999')).status).toBe(404)
  })
})

describe('sync routes: the detached run', () => {
  it('answers 202 with the running row before the run finishes', async () => {
    await connect()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.stubGlobal(
      'fetch',
      mockFetch(async () => {
        await gate
        return Response.json(loadFixture())
      }),
    )
    const r = await post('/api/sync')
    expect(r.status).toBe(202)
    const started = (await r.json()) as Body
    expect(started).toMatchObject({ status: 'running', provider: 'simplefin', added: 0, finished_at: null })
    expect((await get(`/api/sync/runs/${started.id}`)).status).toBe('running')
    release()
    await backgroundSyncsSettled()
    expect(await get(`/api/sync/runs/${started.id}`)).toMatchObject({ status: 'success', added: 295 })
  })

  it('records a failure inside the background run', async () => {
    await connect()
    vi.stubGlobal('fetch', mockFetch(() => Promise.reject(new TypeError('fetch failed'))))
    const started = (await (await post('/api/sync')).json()) as Body
    await backgroundSyncsSettled()
    expect(await get(`/api/sync/runs/${started.id}`)).toMatchObject({
      status: 'error',
      error_text: 'Could not reach SimpleFIN: ConnectError',
      requests: 1,
    })
  })

  it('lists runs with a limit and validates it', async () => {
    await connect()
    const first = (await (await post('/api/sync')).json()) as Body
    await backgroundSyncsSettled()
    const second = (await (await post('/api/sync')).json()) as Body
    await backgroundSyncsSettled()
    const all = (await (await ctx.app.request('/api/sync/runs')).json()) as Body[]
    expect(all.map((x) => x.id)).toEqual([second.id, first.id])
    const one = (await (await ctx.app.request('/api/sync/runs?limit=1')).json()) as Body[]
    expect(one.map((x) => x.id)).toEqual([second.id])
    expect((await ctx.app.request('/api/sync/runs?limit=0')).status).toBe(422)
    expect((await ctx.app.request('/api/sync/runs?limit=101')).status).toBe(422)
  })
})
