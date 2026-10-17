/**
 * What the harness requests: every GET with representative query strings, the endpoint
 * templates that group the report, and the per-endpoint normalization (tie rules).
 */

import type { NormalizeOptions, TieRule } from './normalize.ts'

/** Every operation either app serves, as `METHOD /path/{param}`. */
export const ENDPOINTS: readonly string[] = [
  'GET /api/health',
  'GET /api/auth/session',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/accounts',
  'POST /api/sync',
  'GET /api/sync/schedule',
  'GET /api/sync/runs',
  'GET /api/sync/runs/{run_id}',
  'GET /api/settings/simplefin',
  'POST /api/settings/simplefin',
  'DELETE /api/settings/simplefin',
  'GET /api/settings/llm',
  'GET /api/settings/config',
  'PUT /api/settings/config',
  'GET /api/transactions',
  'PATCH /api/transactions/{transaction_id}',
  'GET /api/categories',
  'POST /api/categories',
  'PATCH /api/categories/{category_id}',
  'GET /api/rules',
  'DELETE /api/rules/{rule_id}',
  'GET /api/reports/changes',
  'POST /api/reports/changes/dismiss',
  'DELETE /api/reports/changes/dismissals',
  'GET /api/reports/monthly',
  'GET /api/reports/month/{month}',
  'GET /api/reports/by-category',
  'GET /api/reports/balances',
  'GET /api/projection',
  'GET /api/recurring',
  'POST /api/recurring',
  'PATCH /api/recurring/{recurring_id}',
  'GET /api/manual-entries',
  'POST /api/manual-entries',
  'PATCH /api/manual-entries/{entry_id}',
  'DELETE /api/manual-entries/{entry_id}',
  'GET /api/goals',
  'POST /api/goals',
  'GET /api/goals/{goal_id}',
  'PATCH /api/goals/{goal_id}',
  'GET /api/goals/{goal_id}/suggestions',
  'POST /api/goals/{goal_id}/suggestions',
  'PATCH /api/suggestions/{suggestion_id}',
]

/** Operations the harness never sends, with the reason. Shown in the report. */
export const NOT_COMPARED: readonly { endpoint: string; reason: string }[] = [
  {
    endpoint: 'GET /api/auth/session',
    reason: 'Python only, and a 501 stub there; the desktop contract (0B) drops auth.',
  },
  { endpoint: 'POST /api/auth/login', reason: 'Python only stub; the desktop contract drops auth.' },
  { endpoint: 'POST /api/auth/logout', reason: 'Python only stub; the desktop contract drops auth.' },
  {
    endpoint: 'GET /api/settings/config',
    reason: 'TypeScript only: the runtime config endpoint is new in the desktop contract (0B).',
  },
  {
    endpoint: 'PUT /api/settings/config',
    reason: 'TypeScript only: the runtime config endpoint is new in the desktop contract (0B).',
  },
  {
    endpoint: 'POST /api/settings/simplefin',
    reason: 'Claiming a setup token calls the SimpleFIN bridge over the network; covered by unit tests.',
  },
]

export interface GetCase {
  endpoint: string
  path: string
}

/** Values read from the Python app (the oracle) once, then used verbatim for both apps. */
export interface Lookup {
  /** The largest spending category this month, for the category filter. */
  categoryId: number | null
}

const DAY_MS = 86_400_000

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

/** The `YYYY-MM` month `months` away from the month of `day`. */
export function monthOffset(day: string, months: number): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + months
  const year = Math.floor(index / 12)
  return `${String(year).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`
}

export function getCases(today: string, lookup: Lookup): GetCase[] {
  const m0 = monthOffset(today, 0)
  const m1 = monthOffset(today, -1)
  const m6 = monthOffset(today, -6)
  const m7 = monthOffset(today, -7)
  const next = monthOffset(today, 1)
  const monthStart = `${m0}-01`
  const cases: Record<string, string[]> = {
    'GET /api/health': [''],
    'GET /api/accounts': [''],
    'GET /api/categories': ['', '?include_hidden=true'],
    'GET /api/rules': [''],
    'GET /api/transactions': [
      '',
      '?limit=500',
      '?limit=100&offset=50',
      '?offset=10000',
      '?q=coffee',
      '?q=PAYROLL',
      `?start=${monthStart}&end=${today}`,
      `?start=${m1}-01&end=${addDays(monthStart, -1)}&limit=500`,
      '?account_id=1&account_id=3',
      '?account_id=2&limit=500',
      ...(lookup.categoryId === null ? [] : [`?category_id=${lookup.categoryId}`]),
      '?essentiality=essential&limit=500',
      '?essentiality=flexible&limit=500',
      '?essentiality=discretionary&limit=500',
      '?essentiality=unset&limit=500',
      '?uncategorized=true&limit=500',
      '?needs_review=true&limit=500',
      '?include_transfers=true&limit=500',
      `?include_transfers=true&start=${monthStart}&q=transfer`,
      '?limit=0',
      '?start=not-a-date',
      '?essentiality=bogus',
    ],
    'GET /api/reports/monthly': ['', '?months=1', '?months=6', '?months=24', '?months=0'],
    'GET /api/reports/month/{month}': [m0, m1, m6, m7, next, '2026-13'].map((m) => `/${m}`),
    'GET /api/reports/by-category': [
      `?month=${m0}`,
      `?month=${m1}`,
      `?month=${m6}`,
      `?month=${m1}&essentiality=essential`,
      `?month=${m1}&essentiality=flexible`,
      `?month=${m1}&essentiality=discretionary`,
      `?month=${m1}&essentiality=unset`,
      `?month=${m7}`,
      '?month=2026-13',
      '',
    ],
    'GET /api/reports/balances': [
      '',
      `?start=${monthStart}&end=${today}`,
      `?start=${m6}-01`,
      `?end=${addDays(monthStart, -1)}`,
      `?start=${today}&end=${monthStart}`,
    ],
    'GET /api/reports/changes': ['', '?all=true'],
    'GET /api/projection': ['', '?months=1', '?months=12', '?months=13'],
    'GET /api/recurring': ['', '?status=proposed', '?status=confirmed', '?status=dismissed'],
    'GET /api/manual-entries': [''],
    'GET /api/goals': [''],
    'GET /api/goals/{goal_id}': ['/999999'],
    'GET /api/goals/{goal_id}/suggestions': ['/999999/suggestions'],
    'GET /api/settings/simplefin': [''],
    'GET /api/settings/llm': [''],
    'GET /api/sync/schedule': [''],
    'GET /api/sync/runs': ['', '?limit=1'],
    'GET /api/sync/runs/{run_id}': ['/1', '/999999'],
  }
  const out: GetCase[] = []
  for (const [endpoint, suffixes] of Object.entries(cases)) {
    // A templated endpoint's suffix carries its path parameters: '/999999/suggestions'.
    const base = endpoint.slice('GET '.length).replace(/\/\{.*$/, '')
    for (const suffix of suffixes) out.push({ endpoint, path: `${base}${suffix}` })
  }
  return out
}

const PATTERNS = ENDPOINTS.map((endpoint) => {
  const [method = '', template = ''] = endpoint.split(' ')
  const regex = new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`)
  return { endpoint, method, literal: !template.includes('{'), regex }
}).sort((a, b) => Number(b.literal) - Number(a.literal))

/** The template for a concrete request; the request itself when no template matches. */
export function templateFor(method: string, path: string): string {
  const bare = path.split('?')[0] ?? path
  const hit = PATTERNS.find((p) => p.method === method && p.regex.test(bare))
  return hit ? hit.endpoint : `${method} ${bare}`
}

const CATEGORY_TIES =
  'aggregates.category_totals sorts by total only (sorted(..., key=total)), so categories with ' +
  'equal totals keep the order of a GROUP BY without ORDER BY, which Postgres leaves ' +
  'unspecified. Ties are compared ordered by category_id; the total order itself is checked.'

/** Lists whose Python order is partial. Each one is documented in the report. */
export const TIE_RULES: Readonly<Record<string, readonly TieRule[]>> = {
  'GET /api/reports/by-category': [
    { path: '', orderBy: 'total', tieBreak: 'category_id', reason: CATEGORY_TIES },
  ],
  'GET /api/reports/month/{month}': [
    { path: '/categories', orderBy: 'total', tieBreak: 'category_id', reason: CATEGORY_TIES },
  ],
}

export function normalizeOptionsFor(endpoint: string): NormalizeOptions {
  return { ties: TIE_RULES[endpoint] ?? [] }
}

/** The normalization rules, as listed in the report. */
export function ruleNotes(): string[] {
  const notes = [
    'Timestamps (ISO 8601 with time and offset) compare as instants rounded half up to the ' +
      'second: Python writes microseconds, JavaScript milliseconds, and `Z` equals `+00:00`.',
    'Wall-clock fields (created_at, updated_at, started_at, finished_at, connected_at, ' +
      'next_run_at) are set from the clock of the process that wrote the row, so two apps loaded ' +
      'seconds apart cannot agree. A valid instant there is masked; null, a naive timestamp, or a ' +
      'non-string stays visible and is compared.',
    'Money and dates are strings and compare exactly; "15.5" and "15.50" differ.',
    'Numbers compare with ===, so -0 equals 0 (Python prints a float ratio as -0.0 or 1.0, ' +
      'JavaScript as 0 or 1).',
    'Text ordering is not normalized: Postgres sorts with the en_US.utf8 collation, SQLite by ' +
      'bytes. Any such difference stays in the report for checkpoint B.',
    'Object key order is ignored (JSON objects are unordered). List order is compared except ' +
      'for the tie rules below.',
    'Status code and media type (without parameters) are compared with the body.',
  ]
  for (const [endpoint, rules] of Object.entries(TIE_RULES)) {
    for (const r of rules) {
      notes.push(
        `Tie rule, \`${endpoint}\` at \`${r.path || '/'}\`: items with equal \`${r.orderBy}\` ` +
          `are ordered by \`${r.tieBreak}\` before comparing. ${r.reason}`,
      )
    }
  }
  return notes
}
