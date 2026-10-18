/**
 * A fake SimpleFIN bridge on loopback, so both apps claim a setup token and sync over real HTTP
 * without the network. Each successful claim gets its own access URL (app1, app2, ...: the
 * Python app always claims first), so the request log can compare what each app asked for.
 *
 * Fake data only: it serves the demo fixture plus a few dated extra rows.
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Json } from './normalize.ts'
import type { CheckResult } from './report.ts'

/** ok: fixture plus extras; errors: a bridge error and one pending row missing; fail: HTTP 500. */
export type BridgeMode = 'ok' | 'errors' | 'drop-pending' | 'fail'
export type TokenKind = 'ok' | 'rejected' | 'unreachable' | 'no-claim-url' | 'not-utf8' | 'not-base64'

/** What the write steps need from the bridge. */
export interface BridgeControl {
  token(kind: TokenKind): string
  setMode(mode: BridgeMode): void
  setDelay(ms: number): void
}

export interface BridgeRequest {
  /** `appN` for a claim or an authorized request, `rejected` for a rejected claim or bad auth. */
  client: string
  method: string
  path: string
  query: Record<string, string>
}

export interface Bridge extends BridgeControl {
  url: string
  requests(): BridgeRequest[]
  close(): Promise<void>
}

export const EXTRA_IDS = ['PARITY-CAFE', 'PARITY-OWNER', 'PARITY-PENDING', 'PARITY-HOLD'] as const

const DAY_S = 86_400

/** Noon UTC `days` before `today`, as SimpleFIN's epoch seconds. */
function noon(today: string, daysBefore: number): number {
  return Date.parse(`${today}T12:00:00Z`) / 1000 - daysBefore * DAY_S
}

export function encodeToken(claimUrl: string): string {
  return Buffer.from(claimUrl, 'utf8').toString('base64')
}

type Obj = { [key: string]: Json }
const isObj = (v: Json | undefined): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The fixture with extra rows on its first account, for `mode`. Never mutates `fixture`. Posted
 * rows are dated from `today` (PLUTUS_TODAY); the pending row from `clockToday`, because both
 * apps take the sync window from the clock and drop only stale pending rows inside it.
 */
export function bridgePayload(fixture: Json, today: string, mode: BridgeMode, clockToday: string): Json {
  const payload = structuredClone(fixture)
  if (!isObj(payload) || !Array.isArray(payload.accounts)) throw new Error('fixture has no accounts')
  const extras: Obj[] = [
    { id: 'PARITY-CAFE', posted: noon(today, 2), amount: '-8.40', description: 'CAF\u00c9 DE LA PAIX PARIS FR' },
    { id: 'PARITY-OWNER', posted: noon(today, 3), amount: '150.00', description: 'ZELLE FROM ALEX SAMPLE 4417' },
    {
      id: 'PARITY-PENDING',
      pending: true,
      transacted_at: noon(clockToday, 1),
      amount: '-4.10',
      description: 'STRASSE BAKERY BERLIN',
    },
    { id: 'PARITY-HOLD', pending: true, amount: '-1.00', description: 'PARITY CARD HOLD' },
  ]
  const first = payload.accounts[0]
  if (!isObj(first) || !Array.isArray(first.transactions)) throw new Error('fixture account has no transactions')
  const kept = mode === 'ok' ? extras : extras.filter((t) => t.id !== 'PARITY-PENDING')
  first.transactions.push(...kept)
  payload.errors = mode === 'errors' ? ['Parity: the connection to Example Bank needs attention.'] : []
  return payload
}

function readBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on('data', () => {})
    req.on('end', () => resolve())
  })
}

/** Start the bridge on 127.0.0.1. `unreachablePort` must have no listener. */
export async function startBridge(
  fixture: Json,
  today: string,
  unreachablePort: number,
  clockToday: string = new Date().toISOString().slice(0, 10),
): Promise<Bridge> {
  const log: BridgeRequest[] = []
  const passwords = new Map<string, string>()
  let mode: BridgeMode = 'ok'
  let delay = 0
  let url = ''

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    await readBody(req)
    const parsed = new URL(req.url ?? '/', 'http://bridge')
    const query = Object.fromEntries(parsed.searchParams)
    const entry = (client: string) => log.push({ client, method: req.method ?? '', path: parsed.pathname, query })

    if (req.method === 'POST' && parsed.pathname === '/claim/ok') {
      const client = `app${passwords.size + 1}`
      const password = `parity-${passwords.size + 1}`
      passwords.set(client, password)
      entry(client)
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`http://${client}:${password}@${url.slice('http://'.length)}/simplefin`)
      return
    }
    if (req.method === 'POST' && parsed.pathname === '/claim/rejected') {
      entry('rejected')
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden')
      return
    }
    if (req.method === 'GET' && parsed.pathname === '/simplefin/accounts') {
      const [scheme, encoded = ''] = (req.headers.authorization ?? '').split(' ')
      const [user = '', password] = Buffer.from(encoded, 'base64').toString('utf8').split(':')
      if (scheme !== 'Basic' || passwords.get(user) !== password) {
        entry('rejected')
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden')
        return
      }
      entry(user)
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
      if (mode === 'fail') {
        res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal Server Error')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(bridgePayload(fixture, today, mode, clockToday)))
      return
    }
    entry('unknown')
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found')
  }

  const server: Server = createServer((req, res) => void handle(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url,
    token(kind) {
      switch (kind) {
        case 'ok':
          return encodeToken(`${url}/claim/ok`)
        case 'rejected':
          return encodeToken(`${url}/claim/rejected`)
        case 'unreachable':
          return encodeToken(`http://127.0.0.1:${unreachablePort}/claim`)
        case 'no-claim-url':
          return encodeToken('ftp://bridge.invalid/claim')
        case 'not-utf8':
          return '/w=='
        case 'not-base64':
          return 'not a setup token!'
      }
    },
    setMode: (m) => void (mode = m),
    setDelay: (ms) => void (delay = ms),
    requests: () => [...log],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const describeRequest = (r: BridgeRequest) => {
  const query = Object.keys(r.query)
    .sort()
    .map((k) => `${k}=${r.query[k]}`)
    .join('&')
  return `${r.method} ${r.path}${query === '' ? '' : `?${query}`}`
}

/** Did `a` (Python) and `b` ask the bridge the same things in the same order? */
export function compareBridgeRequests(log: BridgeRequest[], a = 'app1', b = 'app2'): CheckResult {
  const name = 'SimpleFIN bridge requests'
  const left = log.filter((r) => r.client === a).map(describeRequest)
  const right = log.filter((r) => r.client === b).map(describeRequest)
  if (left.length === 0 || right.length === 0) {
    return { name, ok: false, detail: `Python made ${left.length} requests, the other app ${right.length}` }
  }
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      return {
        name,
        ok: false,
        detail: `request ${i + 1} differs: Python "${left[i] ?? '(none)'}", other app "${right[i] ?? '(none)'}"`,
      }
    }
  }
  return { name, ok: true, detail: `${left.length} requests each, same order: ${[...new Set(left)].join('; ')}` }
}
