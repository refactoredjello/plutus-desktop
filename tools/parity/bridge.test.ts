import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Bridge,
  type BridgeRequest,
  EXTRA_IDS,
  bridgePayload,
  compareBridgeRequests,
  encodeToken,
  startBridge,
} from './bridge.ts'
import type { Json } from './normalize.ts'

const TODAY = '2026-09-30'

const FIXTURE: Json = {
  errors: [],
  accounts: [
    {
      id: 'ACT-chk-001',
      name: 'Everyday Checking',
      currency: 'USD',
      balance: '100.00',
      'balance-date': 1790769600,
      org: { name: 'Example Bank' },
      transactions: [{ id: 'T1', posted: 1790683200, amount: '-5.00', description: 'COFFEE' }],
    },
    { id: 'ACT-cc-002', name: 'Rewards Visa', balance: '-20.00', transactions: [] },
  ],
}

type Payload = { errors: string[]; accounts: { id: string; transactions: { id: string; [k: string]: Json }[] }[] }

const decode = (token: string) => Buffer.from(token, 'base64').toString('utf8')

describe('encodeToken', () => {
  it('is the standard base64 of the claim URL, as SimpleFIN setup tokens are', () => {
    expect(decode(encodeToken('http://127.0.0.1:5000/claim/ok'))).toBe('http://127.0.0.1:5000/claim/ok')
    expect(encodeToken('ftp://x')).toBe(Buffer.from('ftp://x').toString('base64'))
  })
})

describe('bridgePayload', () => {
  it('serves the fixture plus extra rows dated from today, without changing the fixture', () => {
    const before = structuredClone(FIXTURE)
    const p = bridgePayload(FIXTURE, TODAY, 'ok') as Payload
    expect(FIXTURE).toEqual(before)
    expect(p.errors).toEqual([])
    const checking = p.accounts[0]!
    expect(checking.transactions.map((t) => t.id)).toEqual(['T1', ...EXTRA_IDS])
    const byId = Object.fromEntries(checking.transactions.map((t) => [t.id, t]))
    // Posted two days before today, at noon UTC.
    expect(byId['PARITY-CAFE']?.posted).toBe(Date.parse('2026-09-28T12:00:00Z') / 1000)
    expect(byId['PARITY-CAFE']?.description).toBe('CAF\u00c9 DE LA PAIX PARIS FR')
    // A pending charge with a transaction time and none with neither.
    expect(byId['PARITY-PENDING']).toMatchObject({ pending: true, transacted_at: Date.parse('2026-09-29T12:00:00Z') / 1000 })
    expect(byId['PARITY-PENDING']?.posted).toBeUndefined()
    expect(byId['PARITY-HOLD']).toMatchObject({ pending: true })
    expect(byId['PARITY-HOLD']?.transacted_at).toBeUndefined()
    expect(p.accounts[1]?.transactions).toEqual([])
  })

  it('reports a bridge error and leaves out one pending row in errors mode', () => {
    const p = bridgePayload(FIXTURE, TODAY, 'errors') as Payload
    expect(p.errors).toHaveLength(1)
    expect(p.errors[0]).toMatch(/Example Bank/)
    expect(p.accounts[0]?.transactions.map((t) => t.id)).not.toContain('PARITY-PENDING')
  })

  it('leaves out the same pending row without an error in drop-pending mode', () => {
    const p = bridgePayload(FIXTURE, TODAY, 'drop-pending') as Payload
    expect(p.errors).toEqual([])
    expect(p.accounts[0]?.transactions.map((t) => t.id)).not.toContain('PARITY-PENDING')
    expect(p.accounts[0]?.transactions.map((t) => t.id)).toContain('PARITY-HOLD')
  })
})

describe('startBridge', () => {
  let bridge: Bridge
  beforeAll(async () => {
    bridge = await startBridge(FIXTURE, TODAY, 1)
  })
  afterAll(async () => {
    await bridge.close()
  })

  const claim = async (kind: 'ok' | 'rejected') => {
    const url = decode(bridge.token(kind))
    const res = await fetch(url, { method: 'POST' })
    return { status: res.status, text: await res.text() }
  }

  const accounts = async (accessUrl: string, query = '?start-date=1&end-date=2&pending=1') => {
    const u = new URL(accessUrl)
    const auth = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`
    u.username = ''
    u.password = ''
    return fetch(`${u.toString().replace(/\/$/, '')}/accounts${query}`, { headers: { authorization: auth } })
  }

  it('hands out one access URL per claim, each with its own credentials', async () => {
    const first = await claim('ok')
    const second = await claim('ok')
    expect(first.status).toBe(200)
    expect(first.text).toMatch(/^http:\/\/app1:[^@]+@127\.0\.0\.1:\d+\/simplefin$/)
    expect(second.text).toMatch(/^http:\/\/app2:/)
  })

  it('rejects a rejected claim with 403', async () => {
    expect((await claim('rejected')).status).toBe(403)
  })

  it('builds the other tokens', () => {
    expect(decode(bridge.token('unreachable'))).toBe('http://127.0.0.1:1/claim')
    expect(decode(bridge.token('no-claim-url'))).toMatch(/^ftp:\/\//)
    expect(bridge.token('not-utf8')).toBe('/w==')
    expect(bridge.token('not-base64')).toContain(' ')
  })

  it('serves accounts with Basic auth only, in the current mode, and logs each request by client', async () => {
    const access = (await claim('ok')).text
    const client = new URL(access).username
    const ok = await accounts(access)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as Payload).accounts).toHaveLength(2)

    const bad = new URL(access)
    bad.password = 'wrong'
    expect((await accounts(bad.toString())).status).toBe(403)

    bridge.setMode('fail')
    expect((await accounts(access)).status).toBe(500)
    bridge.setMode('errors')
    expect(((await (await accounts(access)).json()) as Payload).errors).toHaveLength(1)
    bridge.setMode('ok')

    const mine = bridge.requests().filter((r) => r.client === client)
    expect(mine.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /claim/ok',
      'GET /simplefin/accounts',
      'GET /simplefin/accounts',
      'GET /simplefin/accounts',
    ])
    expect(mine[1]?.query).toEqual({ 'start-date': '1', 'end-date': '2', pending: '1' })
  })

  it('delays account responses when asked', async () => {
    const access = (await claim('ok')).text
    bridge.setDelay(150)
    const start = Date.now()
    await accounts(access)
    expect(Date.now() - start).toBeGreaterThanOrEqual(140)
    bridge.setDelay(0)
  })
})

describe('compareBridgeRequests', () => {
  const req = (client: string, path: string, query: Record<string, string> = {}): BridgeRequest => ({
    client,
    method: path.startsWith('/claim') ? 'POST' : 'GET',
    path,
    query,
  })

  it('passes when both apps asked the bridge the same things in the same order', () => {
    const log = [
      req('app1', '/claim/ok'),
      req('app2', '/claim/ok'),
      req('app1', '/simplefin/accounts', { 'start-date': '1', pending: '1' }),
      req('app2', '/simplefin/accounts', { pending: '1', 'start-date': '1' }),
    ]
    const result = compareBridgeRequests(log)
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('2 requests each')
  })

  it('fails and names the first different request', () => {
    const log = [
      req('app1', '/simplefin/accounts', { 'start-date': '1' }),
      req('app2', '/simplefin/accounts', { 'start-date': '2' }),
    ]
    const result = compareBridgeRequests(log)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('start-date')
  })

  it('fails when one app made fewer requests or none at all', () => {
    expect(compareBridgeRequests([req('app1', '/claim/ok')]).ok).toBe(false)
    expect(compareBridgeRequests([]).ok).toBe(false)
  })
})
