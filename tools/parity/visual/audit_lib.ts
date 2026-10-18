/**
 * Pure helpers for the Electron request audit (audit.ts runs them in the desktop app).
 * Unit-tested in ../audit.test.ts.
 */

import { CONFIG_PATH } from '../config_check.ts'
import { getCases, templateFor } from '../endpoints.ts'
import { bridgeSteps } from '../sync_steps.ts'
import { type State, WRITE_STEPS } from '../writes.ts'

export interface Route {
  path: string
  /** Loaded directly with loadURL (a deep link), not by in-app navigation. */
  direct?: boolean
}

/** Every route in web/src/app/router.tsx; `month/:month` as a deep link to a month with data. */
export const ROUTES: readonly Route[] = [
  { path: '/' },
  { path: '/month' },
  { path: '/month/2026-08', direct: true },
  { path: '/transactions' },
  { path: '/review' },
  { path: '/spending' },
  { path: '/recurring' },
  { path: '/goals' },
  { path: '/planned' },
  { path: '/settings' },
]

export function fileName(path: string): string {
  const bare = (path.split('?')[0] ?? path).replace(/^\/+|\/+$/g, '')
  return bare === '' ? 'overview' : bare.replaceAll('/', '-').toLowerCase()
}

export interface RequestKey {
  endpoint: string
  /** Sorted, distinct query parameter names joined by commas. */
  params: string
}

/** Method, endpoint template, and query keys of an /api request; null for anything else. */
export function requestKey(method: string, url: string): RequestKey | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!parsed.pathname.startsWith('/api/')) return null
  const params = [...new Set(parsed.searchParams.keys())].sort().join(',')
  return { endpoint: templateFor(method, parsed.pathname), params }
}

const keyText = (k: RequestKey) => `${k.endpoint}?${k.params}`

/** Every request shape the parity harness compares: GET cases, re-reads, and writes. */
export function harnessKeys(today: string): Set<string> {
  const keys = new Set<string>()
  const add = (method: string, path: string) => {
    const k = requestKey(method, `http://harness${path}`)
    if (k !== null) keys.add(keyText(k))
  }
  for (const c of getCases(today, { categoryId: 1 })) add('GET', c.path)
  add('GET', CONFIG_PATH) // TypeScript only: a setup check, not a diff
  // Any captured id will do: only the template and the query keys matter.
  const state = new Proxy({} as State, { get: () => 1 })
  const bridge = { token: () => 'token', setMode: () => {}, setDelay: () => {} }
  for (const step of [...WRITE_STEPS, ...bridgeSteps(bridge)]) {
    keys.add(`${step.endpoint}?`)
    for (const path of step.reread(state, today)) add('GET', path)
  }
  return keys
}

/** Distinct UI request shapes the harness never compares. */
export function coverageGaps(ui: readonly RequestKey[], harness: ReadonlySet<string>): string[] {
  return [...new Set(ui.map(keyText))].filter((k) => !harness.has(k)).sort()
}

export interface AuditRequest {
  method: string
  /** Path and query. */
  url: string
  status: number | null
  contentType: string | null
  failed?: string
}

export interface RouteAudit {
  path: string
  requests: AuditRequest[]
  console: string[]
  exceptions: string[]
  /** Failed or blocked requests, 4xx and 5xx, console errors and warnings, page errors. */
  problems: string[]
}

const pathOf = (url: string) => {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}`
  } catch {
    return url
  }
}

/**
 * Accepted class: Chromium asks the HTTP cache alone for a web font first and fails with
 * ERR_CACHE_MISS when it is not there, then fetches it. Only when a later request for the
 * same URL in the same route succeeds.
 */
function isFontProbe(q: AuditRequest, later: readonly AuditRequest[]): boolean {
  return (
    q.failed === 'net::ERR_CACHE_MISS' &&
    later.some((l) => l.url === q.url && l.method === q.method && l.status !== null && l.status < 400)
  )
}

/** Collects what the page did, route by route, from DevTools protocol events. */
export class AuditLog {
  readonly #routes: RouteAudit[] = []
  readonly #byId = new Map<string, AuditRequest>()
  readonly #open = new Set<string>()

  route(path: string): void {
    this.#routes.push({ path, requests: [], console: [], exceptions: [], problems: [] })
  }

  #current(): RouteAudit {
    const r = this.#routes.at(-1)
    if (r === undefined) throw new Error('no route started')
    return r
  }

  request(id: string, method: string, url: string): void {
    const entry: AuditRequest = { method, url: pathOf(url), status: null, contentType: null }
    this.#byId.set(id, entry)
    this.#open.add(id)
    this.#current().requests.push(entry)
  }

  response(id: string, status: number, contentType: string | null): void {
    const entry = this.#byId.get(id)
    if (entry === undefined) return
    entry.status = status
    entry.contentType = contentType
  }

  finished(id: string): void {
    this.#open.delete(id)
  }

  failed(id: string, errorText: string, blockedReason?: string): void {
    this.#open.delete(id)
    const entry = this.#byId.get(id)
    if (entry === undefined) return
    entry.failed = blockedReason ? `${errorText} (${blockedReason})` : errorText
  }

  console(level: string, text: string): void {
    if (level !== 'error' && level !== 'warning') return
    this.#current().console.push(`${level}: ${text}`)
  }

  exception(text: string): void {
    this.#current().exceptions.push(text)
  }

  inFlight(): number {
    return this.#open.size
  }

  results(): RouteAudit[] {
    return this.#routes.map((r) => ({
      ...r,
      problems: [
        ...r.requests.flatMap((q, i) =>
          q.failed !== undefined && !isFontProbe(q, r.requests.slice(i + 1))
            ? [`${q.method} ${q.url}: ${q.failed}`]
            : q.status !== null && q.status >= 400
              ? [`${q.method} ${q.url}: ${q.status}`]
              : [],
        ),
        ...r.console.map((c) => `console ${c}`),
        ...r.exceptions.map((e) => `page error: ${e}`),
      ],
    }))
  }
}

/** One line of the event stream electron_main.mjs writes (events.ndjson). */
type AuditEvent =
  | { t: 'route'; path: string }
  | { t: 'request'; id: number | string; method: string; url: string }
  | { t: 'response'; id: number | string; status: number; contentType: string | null }
  | { t: 'finished'; id: number | string }
  | { t: 'failed'; id: number | string; error: string }
  | { t: 'console'; level: string; text: string }
  | { t: 'exception'; text: string }
  | { t: 'screenshot'; path: string; file: string }

const isHttp = (url: string) => url.startsWith('http://') || url.startsWith('https://')
const media = (contentType: string | null) => contentType?.split(';')[0]?.trim().toLowerCase() || null
const BEFORE = '(before the first route)'

/** The per-route log, rebuilt from the Electron event stream. Non-http requests are dropped. */
export function replayEvents(lines: readonly string[]): RouteAudit[] {
  const log = new AuditLog()
  const seen = new Set<string>()
  let started = false
  const ensureRoute = () => {
    if (!started) log.route(BEFORE)
    started = true
  }
  for (const line of lines) {
    if (line.trim() === '') continue
    let e: AuditEvent
    try {
      e = JSON.parse(line) as AuditEvent
    } catch {
      ensureRoute()
      log.exception(`audit: unreadable event ${line}`)
      continue
    }
    if (e.t === 'route') {
      log.route(e.path)
      started = true
      continue
    }
    ensureRoute()
    const id = 'id' in e ? String(e.id) : ''
    if (e.t === 'request') {
      if (!isHttp(e.url)) continue
      seen.add(id)
      log.request(id, e.method, e.url)
    } else if (e.t === 'response') {
      if (seen.has(id)) log.response(id, e.status, media(e.contentType))
    } else if (e.t === 'finished') {
      log.finished(id)
    } else if (e.t === 'failed') {
      if (seen.has(id)) log.failed(id, e.error)
    } else if (e.t === 'console') {
      log.console(e.level, e.text)
    } else if (e.t === 'exception') {
      log.exception(e.text)
    }
  }
  return log.results()
}

/** The request key of every /api request the pages sent, in order, duplicates kept. */
export function uiKeys(results: readonly RouteAudit[]): RequestKey[] {
  return results.flatMap((r) =>
    r.requests.flatMap((q) => {
      const k = requestKey(q.method, `http://app${q.url}`)
      return k === null ? [] : [k]
    }),
  )
}

export function auditExitCode(results: readonly RouteAudit[], gaps: readonly string[]): 0 | 1 {
  return gaps.length === 0 && results.every((r) => r.problems.length === 0) ? 0 : 1
}

const tableCell = (text: string) => text.replaceAll('|', '\\|')

/** The audit as markdown: every route's requests, problems, and screenshot, then the gaps. */
export function renderAudit(
  results: readonly RouteAudit[],
  gaps: readonly string[],
  screenshots: Readonly<Record<string, string>>,
): string {
  const lines = ['# Electron request audit', '']
  const problems = results.reduce((n, r) => n + r.problems.length, 0)
  lines.push(
    `${results.length} routes, ${problems} problems, ${gaps.length} coverage gaps. ` +
      (auditExitCode(results, gaps) === 0 ? 'Clean.' : 'Not clean: exit status 1.'),
    '',
  )
  for (const r of results) {
    lines.push(`## \`${r.path}\``, '')
    const shot = screenshots[r.path]
    if (shot !== undefined) lines.push(`Screenshot: \`${shot}\``, '')
    lines.push('| Method | Request | Status | Content type |', '|---|---|---|---|')
    for (const q of r.requests) {
      const status = q.failed !== undefined ? `failed: ${q.failed}` : q.status === null ? 'no response' : String(q.status)
      lines.push(`| ${q.method} | \`${tableCell(q.url)}\` | ${tableCell(status)} | ${q.contentType ?? ''} |`)
    }
    lines.push('')
    if (r.problems.length === 0) lines.push('Problems: none.', '')
    else lines.push('Problems:', '', ...r.problems.map((p) => `- ${p}`), '')
  }
  lines.push('## Coverage gaps', '')
  if (gaps.length === 0) lines.push('Every request the pages sent matches a harness case.')
  else lines.push('Requests the pages sent that no harness case compares:', '', ...gaps.map((g) => `- \`${g}\``))
  lines.push('')
  return lines.join('\n')
}
