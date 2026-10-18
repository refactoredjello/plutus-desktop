import { describe, expect, it } from 'vitest'
import type { BridgeControl, BridgeMode, TokenKind } from './bridge.ts'
import type { Envelope } from './diff.ts'
import { templateFor } from './endpoints.ts'
import type { Json } from './normalize.ts'
import { bridgeSteps, waitForIdle, writeSteps } from './sync_steps.ts'
import { type Api, type State, WRITE_STEPS, type WriteStep, runPrepare } from './writes.ts'

const TODAY = '2026-09-30'

function fakeBridge(): BridgeControl & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    token: (kind: TokenKind) => `token:${kind}`,
    setMode: (mode: BridgeMode) => void calls.push(`mode ${mode}`),
    setDelay: (ms: number) => void calls.push(`delay ${ms}`),
  }
}

const env = (status: number, body: Json = null): Envelope => ({ status, contentType: 'application/json', body })

/** An app whose sync is idle after `busyPolls` polls and whose POST /api/sync answers in turn. */
function syncApi(posts: number[], busyPolls = 0): Api & { calls: string[] } {
  const calls: string[] = []
  let polls = 0
  let post = 0
  return {
    calls,
    async send(method, path) {
      calls.push(`${method} ${path}`)
      if (method === 'GET' && path === '/api/sync/runs?limit=100') {
        polls += 1
        return env(200, [{ id: 1, status: polls <= busyPolls ? 'running' : 'success' }])
      }
      if (method === 'POST' && path === '/api/sync') return env(posts[Math.min(post++, posts.length - 1)] ?? 202)
      return env(200, [])
    },
  }
}

const byName = (steps: WriteStep[], name: string): WriteStep => {
  const step = steps.find((s) => s.name === name)
  if (step === undefined) throw new Error(`no step ${name}`)
  return step
}

describe('bridgeSteps', () => {
  it('connects through every claim failure, then syncs, then disconnects', () => {
    expect(bridgeSteps(fakeBridge()).map((s) => s.name)).toEqual([
      'connect with a token that is not base64',
      'connect with a token that is not UTF-8',
      'connect with a token without a claim URL',
      'connect to an unreachable bridge',
      'connect with a rejected token',
      'connect with an empty token',
      'connect SimpleFIN',
      'sync from the bridge',
      'start a sync while one is running',
      'sync with bridge errors',
      'sync after a pending charge disappears',
      'sync when the bridge fails',
      'exhaust the daily request budget',
      'disconnect SimpleFIN after syncing',
      'sync after disconnecting',
    ])
  })

  it('sends the bridge tokens as setup tokens', async () => {
    const steps = bridgeSteps(fakeBridge())
    const api = syncApi([202])
    const connect = await runPrepare(byName(steps, 'connect SimpleFIN'), api, {}, TODAY)
    expect(connect).toEqual({ method: 'POST', path: '/api/settings/simplefin', body: { setup_token: 'token:ok' } })
    const empty = await runPrepare(byName(steps, 'connect with an empty token'), api, {}, TODAY)
    expect(empty.body).toEqual({ setup_token: '' })
    for (const [name, kind] of [
      ['connect with a token that is not base64', 'not-base64'],
      ['connect with a token that is not UTF-8', 'not-utf8'],
      ['connect with a token without a claim URL', 'no-claim-url'],
      ['connect to an unreachable bridge', 'unreachable'],
      ['connect with a rejected token', 'rejected'],
    ] as const) {
      expect((await runPrepare(byName(steps, name), api, {}, TODAY)).body).toEqual({ setup_token: `token:${kind}` })
    }
  })

  it('sets the bridge mode before each sync and waits for the run to finish', async () => {
    const bridge = fakeBridge()
    const steps = bridgeSteps(bridge)
    const api = syncApi([202], 2)
    for (const [name, mode] of [
      ['sync from the bridge', 'ok'],
      ['sync with bridge errors', 'errors'],
      ['sync after a pending charge disappears', 'drop-pending'],
      ['sync when the bridge fails', 'fail'],
    ] as const) {
      bridge.calls.length = 0
      const step = byName(steps, name)
      expect(await runPrepare(step, api, {}, TODAY)).toEqual({ method: 'POST', path: '/api/sync' })
      expect(bridge.calls).toEqual([`mode ${mode}`, 'delay 0'])
      expect(step.settle).toBeDefined()
    }
    expect(await byName(steps, 'sync from the bridge').settle?.(api, {})).toBeNull()
    expect(api.calls.filter((c) => c === 'GET /api/sync/runs?limit=100')).toHaveLength(3)
  })

  it('starts a slow sync before sending the conflicting one, then resets the delay', async () => {
    const bridge = fakeBridge()
    const step = byName(bridgeSteps(bridge), 'start a sync while one is running')
    const api = syncApi([202, 409])
    const req = await runPrepare(step, api, {}, TODAY)
    expect(req).toEqual({ method: 'POST', path: '/api/sync' })
    expect(api.calls).toEqual(['POST /api/sync'])
    expect(bridge.calls[0]).toBe('mode ok')
    expect(Number(bridge.calls[1]?.split(' ')[1])).toBeGreaterThanOrEqual(1000)
    await step.settle?.(api, {})
    expect(bridge.calls.at(-1)).toBe('delay 0')
  })

  it('syncs against a failing bridge until the app refuses, then sends the refused request', async () => {
    const bridge = fakeBridge()
    const step = byName(bridgeSteps(bridge), 'exhaust the daily request budget')
    const api = syncApi([202, 202, 202, 409])
    const req = await runPrepare(step, api, {}, TODAY)
    expect(req).toEqual({ method: 'POST', path: '/api/sync' })
    expect(bridge.calls).toContain('mode fail')
    expect(api.calls.filter((c) => c === 'POST /api/sync')).toHaveLength(4)
    // Each accepted sync is waited for before the next one.
    expect(api.calls.filter((c) => c.startsWith('GET /api/sync/runs'))).toHaveLength(3)
  })

  it('re-reads the sync runs, the data a sync changes, and the connection status', () => {
    const steps = bridgeSteps(fakeBridge())
    const state: State = {}
    expect(byName(steps, 'connect SimpleFIN').reread(state, TODAY)).toContain('/api/settings/simplefin')
    const synced = byName(steps, 'sync from the bridge').reread(state, TODAY)
    for (const path of ['/api/sync/runs?limit=100', '/api/accounts', '/api/transactions?limit=500', '/api/reports/balances']) {
      expect(synced).toContain(path)
    }
    expect(byName(steps, 'exhaust the daily request budget').reread(state, TODAY)).toContain('/api/sync/runs?limit=100')
  })

  it('names each step by the template its request resolves to', async () => {
    const api = syncApi([202, 409])
    for (const step of bridgeSteps(fakeBridge())) {
      const req = await runPrepare(step, api, {}, TODAY)
      expect(templateFor(req.method, req.path)).toBe(step.endpoint)
    }
  })
})

describe('writeSteps', () => {
  it('runs the bridge steps after the scripted sequence', () => {
    const steps = writeSteps(fakeBridge())
    expect(steps.slice(0, WRITE_STEPS.length)).toEqual(WRITE_STEPS)
    expect(steps.slice(WRITE_STEPS.length).map((s) => s.name)[0]).toBe('connect with a token that is not base64')
  })
})

describe('waitForIdle', () => {
  it('polls the sync runs until none is running', async () => {
    const api = syncApi([], 3)
    expect(await waitForIdle(api, 2000, 1)).toBeNull()
    expect(api.calls).toHaveLength(4)
  })

  it('gives up after the timeout with a reason', async () => {
    const api = syncApi([], 1_000_000)
    expect(await waitForIdle(api, 30, 5)).toMatch(/still running/)
  })

  it('reports an app that does not answer the runs list', async () => {
    const api: Api = { send: async () => env(500, 'boom') }
    expect(await waitForIdle(api, 30, 5)).toMatch(/500/)
  })
})
