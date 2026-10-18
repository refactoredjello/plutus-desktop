import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { AuditLog, ROUTES, coverageGaps, fileName, fixedClockScript, harnessKeys, requestKey, seedSteps } from './visual/audit_lib.ts'

const TODAY = '2026-09-30'

describe('ROUTES', () => {
  it('has every route the web router registers, once, and one deep link loaded directly', () => {
    const paths = ROUTES.map((r) => r.path)
    for (const p of ['/', '/month', '/transactions', '/review', '/spending', '/recurring', '/goals', '/planned', '/settings']) {
      expect(paths).toContain(p)
    }
    expect(new Set(paths).size).toBe(paths.length)
    const deep = ROUTES.filter((r) => r.direct === true)
    expect(deep).toHaveLength(1)
    expect(deep[0]?.path).toMatch(/^\/month\/\d{4}-\d{2}$/)
  })

  it('matches every path in web/src/app/router.tsx', () => {
    const router = readFileSync(new URL('../../web/src/app/router.tsx', import.meta.url), 'utf8')
    const registered = [...router.matchAll(/path: '([^']+)'/g)].map((m) => `/${m[1]}`)
    expect(registered.length).toBeGreaterThan(5)
    for (const r of registered) {
      const pattern = new RegExp(`^${r.replace(/:[a-z]+/g, '[^/]+')}$`)
      expect(ROUTES.some((route) => pattern.test(route.path))).toBe(true)
    }
  })

  it('gives each route a distinct file name', () => {
    const names = ROUTES.map((r) => fileName(r.path))
    expect(new Set(names).size).toBe(names.length)
    expect(fileName('/')).toBe('overview')
    expect(fileName('/month/2026-08')).toBe('month-2026-08')
  })
})

describe('fixedClockScript', () => {
  it('makes new Date() and Date.now() start at the fixed instant, leaving explicit dates alone', () => {
    const script = fixedClockScript('2026-09-30T12:00:00Z')
    const result = runInNewContext(
      `${script}; ({ now: Date.now(), made: new Date().toISOString(), explicit: new Date(0).toISOString(), parsed: Date.parse('2020-01-01T00:00:00Z'), isDate: new Date() instanceof Date, utc: Date.UTC(2020, 0, 1) })`,
      { Date },
    ) as Record<string, unknown>
    const fixed = Date.parse('2026-09-30T12:00:00Z')
    expect(result.now as number).toBeGreaterThanOrEqual(fixed)
    expect(result.now as number).toBeLessThan(fixed + 5000)
    expect((result.made as string).slice(0, 13)).toBe('2026-09-30T12')
    expect(result.explicit).toBe('1970-01-01T00:00:00.000Z')
    expect(result.parsed).toBe(Date.parse('2020-01-01T00:00:00Z'))
    expect(result.isDate).toBe(true)
    expect(result.utc).toBe(Date.UTC(2020, 0, 1))
  })
})

describe('seedSteps', () => {
  it('gives the app a goal, planned entries, and a confirmed recurrence', () => {
    const steps = seedSteps(TODAY)
    const paths = steps.map((s) => `${s.method} ${s.path}`)
    expect(paths).toContain('POST /api/goals')
    expect(paths.filter((p) => p === 'POST /api/manual-entries')).toHaveLength(2)
    expect(steps.some((s) => s.confirmFirstProposed === true)).toBe(true)
  })
})

describe('requestKey', () => {
  it('reduces an API request to method, endpoint template, and sorted query keys', () => {
    expect(requestKey('GET', 'http://127.0.0.1:5123/api/transactions?start=2026-09-01&limit=50&offset=0')).toEqual({
      endpoint: 'GET /api/transactions',
      params: 'limit,offset,start',
    })
    expect(requestKey('GET', 'http://127.0.0.1:5123/api/reports/month/2026-08')).toEqual({
      endpoint: 'GET /api/reports/month/{month}',
      params: '',
    })
    expect(requestKey('GET', 'http://x/api/transactions?account_id=1&account_id=2')?.params).toBe('account_id')
  })

  it('ignores requests outside /api', () => {
    expect(requestKey('GET', 'http://127.0.0.1:5123/assets/index.js')).toBeNull()
    expect(requestKey('GET', 'data:image/png;base64,xx')).toBeNull()
  })
})

describe('harnessKeys', () => {
  const keys = harnessKeys(TODAY)

  it('holds every GET the harness compares, initial cases and re-reads', () => {
    expect(keys.has('GET /api/transactions?limit,offset')).toBe(true)
    expect(keys.has('GET /api/reports/month/{month}?')).toBe(true)
    expect(keys.has('GET /api/projection?months')).toBe(true)
    // A re-read path after a write step.
    expect(keys.has('GET /api/transactions?limit,q')).toBe(true)
  })

  it('holds the write endpoints the steps send', () => {
    expect(keys.has('PATCH /api/transactions/{transaction_id}?')).toBe(true)
    expect(keys.has('POST /api/sync?')).toBe(true)
  })
})

describe('coverageGaps', () => {
  it('lists the distinct UI requests the harness never compares', () => {
    const harness = new Set(['GET /api/accounts?', 'GET /api/transactions?limit'])
    const gaps = coverageGaps(
      [
        { endpoint: 'GET /api/accounts', params: '' },
        { endpoint: 'GET /api/transactions', params: 'limit' },
        { endpoint: 'GET /api/transactions', params: 'limit,start' },
        { endpoint: 'GET /api/transactions', params: 'limit,start' },
      ],
      harness,
    )
    expect(gaps).toEqual(['GET /api/transactions?limit,start'])
  })
})

describe('AuditLog', () => {
  it('records requests, responses, failures, console messages, and page errors per route', () => {
    const log = new AuditLog()
    log.route('/')
    log.request('1', 'GET', 'http://127.0.0.1:9/api/accounts')
    log.response('1', 200, 'application/json')
    log.request('2', 'GET', 'http://127.0.0.1:9/assets/missing.js')
    log.response('2', 404, 'text/plain')
    log.request('3', 'GET', 'http://127.0.0.1:9/api/health')
    log.failed('3', 'net::ERR_BLOCKED_BY_CLIENT', 'csp')
    log.console('warning', 'Electron Security Warning')
    log.console('log', 'ignored')
    log.exception('TypeError: x is undefined')
    log.route('/month')
    log.request('4', 'GET', 'http://127.0.0.1:9/api/reports/monthly?months=12')
    log.response('4', 401, 'application/problem+json')

    const [overview, month] = log.results()
    expect(overview?.path).toBe('/')
    expect(overview?.requests).toEqual([
      { method: 'GET', url: '/api/accounts', status: 200, contentType: 'application/json' },
      { method: 'GET', url: '/assets/missing.js', status: 404, contentType: 'text/plain' },
      { method: 'GET', url: '/api/health', status: null, contentType: null, failed: 'net::ERR_BLOCKED_BY_CLIENT (csp)' },
    ])
    expect(overview?.console).toEqual(['warning: Electron Security Warning'])
    expect(overview?.exceptions).toEqual(['TypeError: x is undefined'])
    expect(overview?.problems).toEqual([
      'GET /assets/missing.js: 404',
      'GET /api/health: net::ERR_BLOCKED_BY_CLIENT (csp)',
      'console warning: Electron Security Warning',
      'page error: TypeError: x is undefined',
    ])
    expect(month?.problems).toEqual(['GET /api/reports/monthly?months=12: 401'])
  })

  it('tracks requests still in flight', () => {
    const log = new AuditLog()
    log.route('/')
    log.request('1', 'GET', 'http://h/api/a')
    expect(log.inFlight()).toBe(1)
    log.response('1', 200, 'application/json')
    log.finished('1')
    expect(log.inFlight()).toBe(0)
  })
})
