/**
 * Pure helpers for the Electron request audit (audit.ts runs them in the desktop app).
 * Unit-tested in ../audit.test.ts.
 */

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

/**
 * Page script that starts the browser clock at `iso` (the frontend reads the current month
 * from `new Date()`), so both apps render as of PLUTUS_TODAY. Explicit dates are untouched.
 */
export function fixedClockScript(iso: string): string {
  return `(() => {
  const RealDate = Date
  const offset = RealDate.parse(${JSON.stringify(iso)}) - RealDate.now()
  function FixedDate(...args) {
    if (!new.target) return new RealDate(RealDate.now() + offset).toString()
    return args.length === 0 ? new RealDate(RealDate.now() + offset) : new RealDate(...args)
  }
  FixedDate.prototype = RealDate.prototype
  FixedDate.now = () => RealDate.now() + offset
  FixedDate.parse = RealDate.parse
  FixedDate.UTC = RealDate.UTC
  globalThis.Date = FixedDate
})()`
}

export interface SeedStep {
  method: 'POST' | 'PATCH'
  path: string
  body?: Record<string, unknown>
  /** PATCH the first proposed recurrence (path is a placeholder). */
  confirmFirstProposed?: boolean
  /** Path holds `{goal}`, replaced by the id the first goal POST returned. */
  usesGoal?: boolean
}

const day = (today: string, days: number) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

/** The same requests on both apps before capture, so Goals, Planned, and Recurring have data. */
export function seedSteps(today: string): SeedStep[] {
  return [
    { method: 'POST', path: '/api/goals', body: { name: 'Emergency fund', target_amount: '6000.00', target_date: day(today, 365) } },
    {
      method: 'POST',
      path: '/api/manual-entries',
      body: { amount: '-180.00', description: 'Car registration', due_date: day(today, 14), recurrence: 'none' },
    },
    {
      method: 'POST',
      path: '/api/manual-entries',
      body: { amount: '250.00', description: 'Side income', due_date: day(today, 5), recurrence: 'monthly', end_date: day(today, 120) },
    },
    { method: 'PATCH', path: '/api/recurring/{first proposed}', body: { status: 'confirmed' }, confirmFirstProposed: true },
    { method: 'POST', path: '/api/goals/{goal}/suggestions', usesGoal: true },
  ]
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
        ...r.requests.flatMap((q) =>
          q.failed !== undefined
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
