/**
 * Write steps that need the fake SimpleFIN bridge (bridge.ts): every claim failure, a real
 * connect, syncs in each bridge mode, a conflicting sync, the daily request budget, and
 * disconnect. They run after the scripted sequence in writes.ts.
 */

import type { BridgeControl, BridgeMode, TokenKind } from './bridge.ts'
import { type Api, PrepareError, type StepRequest, WRITE_STEPS, type WriteStep } from './writes.ts'

const RUNS = '/api/sync/runs?limit=100'
const SYNC: StepRequest = { method: 'POST', path: '/api/sync' }

/** Poll the sync runs until none is running. Null when idle, else why not. */
export async function waitForIdle(api: Api, timeoutMs = 60_000, intervalMs = 100): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await api.send('GET', RUNS)
    if (res.status !== 200 || !Array.isArray(res.body)) return `GET ${RUNS} answered ${res.status}`
    const running = res.body.some((r) => r !== null && typeof r === 'object' && !Array.isArray(r) && r.status === 'running')
    if (!running) return null
    if (Date.now() >= deadline) return `a sync was still running after ${timeoutMs} ms`
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

const settle = (api: Api) => waitForIdle(api)

/** What a sync changes. */
const SYNCED = [
  RUNS,
  '/api/accounts',
  '/api/transactions?limit=500',
  '/api/transactions?limit=500&offset=500',
  '/api/transactions?include_transfers=true&limit=500',
  '/api/transactions?needs_review=true&limit=500',
  `/api/transactions?q=${encodeURIComponent('caf\u00e9')}&limit=500`,
  '/api/transactions?q=bakery&limit=500',
  '/api/reports/balances',
  '/api/reports/monthly',
  '/api/reports/changes?all=true',
  '/api/recurring',
  '/api/projection',
]

function connect(name: string, bridge: BridgeControl, kind: TokenKind | null): WriteStep {
  return {
    name,
    endpoint: 'POST /api/settings/simplefin',
    prepare: () => ({
      method: 'POST',
      path: '/api/settings/simplefin',
      body: { setup_token: kind === null ? '' : bridge.token(kind) },
    }),
    reread: () => ['/api/settings/simplefin'],
  }
}

function sync(name: string, bridge: BridgeControl, mode: BridgeMode, reread: string[]): WriteStep {
  return {
    name,
    endpoint: 'POST /api/sync',
    prepare() {
      bridge.setMode(mode)
      bridge.setDelay(0)
      return SYNC
    },
    settle,
    reread: () => reread,
  }
}

/** How long the bridge holds the first sync's request so a second one finds it running. */
const SLOW_MS = 2000
/** More syncs than the daily budget (24 requests) can ever allow. */
const MAX_SYNCS = 30

export function bridgeSteps(bridge: BridgeControl): WriteStep[] {
  return [
    connect('connect with a token that is not base64', bridge, 'not-base64'),
    connect('connect with a token that is not UTF-8', bridge, 'not-utf8'),
    connect('connect with a token without a claim URL', bridge, 'no-claim-url'),
    connect('connect to an unreachable bridge', bridge, 'unreachable'),
    connect('connect with a rejected token', bridge, 'rejected'),
    connect('connect with an empty token', bridge, null),
    connect('connect SimpleFIN', bridge, 'ok'),
    sync('sync from the bridge', bridge, 'ok', SYNCED),
    {
      name: 'start a sync while one is running',
      endpoint: 'POST /api/sync',
      async prepare(api) {
        bridge.setMode('ok')
        bridge.setDelay(SLOW_MS)
        const first = await api.send('POST', '/api/sync')
        if (first.status !== 202) throw new PrepareError(`the first POST /api/sync answered ${first.status}`)
        return SYNC
      },
      async settle(api) {
        const result = await waitForIdle(api)
        bridge.setDelay(0)
        return result
      },
      reread: () => [RUNS],
    },
    sync('sync with bridge errors', bridge, 'errors', SYNCED),
    sync('sync after a pending charge disappears', bridge, 'drop-pending', SYNCED),
    sync('sync when the bridge fails', bridge, 'fail', [RUNS, '/api/accounts']),
    {
      name: 'exhaust the daily request budget',
      endpoint: 'POST /api/sync',
      async prepare(api) {
        bridge.setMode('fail')
        bridge.setDelay(0)
        for (let i = 0; i < MAX_SYNCS; i++) {
          const res = await api.send('POST', '/api/sync')
          if (res.status === 409) return SYNC
          if (res.status !== 202) throw new PrepareError(`POST /api/sync answered ${res.status}`)
          const idle = await waitForIdle(api)
          if (idle !== null) throw new PrepareError(idle)
        }
        throw new PrepareError(`the app still accepted a sync after ${MAX_SYNCS} tries`)
      },
      reread: () => [RUNS],
    },
    {
      name: 'disconnect SimpleFIN after syncing',
      endpoint: 'DELETE /api/settings/simplefin',
      prepare: () => ({ method: 'DELETE', path: '/api/settings/simplefin' }),
      reread: () => ['/api/settings/simplefin'],
    },
    {
      name: 'sync after disconnecting',
      endpoint: 'POST /api/sync',
      prepare: () => SYNC,
      reread: () => [RUNS],
    },
  ]
}

/** The whole write sequence: the scripted steps, then the bridge steps. */
export function writeSteps(bridge: BridgeControl): WriteStep[] {
  return [...WRITE_STEPS, ...bridgeSteps(bridge)]
}
