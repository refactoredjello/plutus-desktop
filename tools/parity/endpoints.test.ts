import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ENDPOINTS,
  NOT_COMPARED,
  TIE_RULES,
  addDays,
  getCases,
  monthOffset,
  normalizeOptionsFor,
  templateFor,
} from './endpoints.ts'

const openapi = JSON.parse(
  readFileSync(new URL('../../web/src/api/openapi.json', import.meta.url), 'utf8'),
) as { paths: Record<string, Record<string, unknown>> }

function contractOperations(): string[] {
  const out: string[] = []
  for (const [path, ops] of Object.entries(openapi.paths)) {
    for (const method of Object.keys(ops)) out.push(`${method.toUpperCase()} ${path}`)
  }
  return out
}

const skipped = new Set(NOT_COMPARED.map((n) => n.endpoint))

describe('date helpers', () => {
  it('shifts months across year boundaries', () => {
    expect(monthOffset('2026-09-30', 0)).toBe('2026-09')
    expect(monthOffset('2026-09-30', -1)).toBe('2026-08')
    expect(monthOffset('2026-09-30', -9)).toBe('2025-12')
    expect(monthOffset('2026-12-01', 1)).toBe('2027-01')
  })

  it('adds days across month ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-09-30', 365)).toBe('2027-09-30')
  })
})

describe('getCases', () => {
  const cases = getCases('2026-09-30', { categoryId: 79 })

  it('covers every GET in the contract that is not explicitly skipped', () => {
    const gets = contractOperations().filter((op) => op.startsWith('GET ') && !skipped.has(op))
    const covered = new Set(cases.map((c) => c.endpoint))
    expect(gets.filter((op) => !covered.has(op))).toEqual([])
  })

  it('names each case by a template that matches its path', () => {
    for (const c of cases) {
      const path = c.path.split('?')[0] ?? ''
      expect(templateFor('GET', path)).toBe(c.endpoint)
    }
  })

  it('has representative query strings, months relative to today, and error cases', () => {
    const paths = cases.map((c) => c.path)
    expect(paths).toContain('/api/reports/month/2026-09')
    expect(paths).toContain('/api/reports/month/2026-10') // not started yet: an error
    expect(paths).toContain('/api/reports/by-category?month=2026-09')
    expect(paths).toContain('/api/transactions?category_id=79')
    expect(paths).toContain('/api/transactions?account_id=1&account_id=3')
    expect(paths).toContain('/api/goals/999999')
    expect(paths.some((p) => p.startsWith('/api/transactions?limit=0'))).toBe(true)
  })

  it('leaves out the category case when no category was found', () => {
    expect(getCases('2026-09-30', { categoryId: null }).some((c) => c.path.includes('category_id'))).toBe(false)
  })

  it('has no duplicate requests', () => {
    const paths = cases.map((c) => c.path)
    expect(new Set(paths).size).toBe(paths.length)
  })
})

describe('templateFor', () => {
  it('resolves concrete paths to contract templates', () => {
    expect(templateFor('GET', '/api/goals/12')).toBe('GET /api/goals/{goal_id}')
    expect(templateFor('GET', '/api/goals/12/suggestions')).toBe('GET /api/goals/{goal_id}/suggestions')
    expect(templateFor('POST', '/api/goals/12/suggestions')).toBe('POST /api/goals/{goal_id}/suggestions')
    expect(templateFor('GET', '/api/reports/changes')).toBe('GET /api/reports/changes')
    expect(templateFor('GET', '/api/reports/month/2026-09')).toBe('GET /api/reports/month/{month}')
    expect(templateFor('PATCH', '/api/transactions/5')).toBe('PATCH /api/transactions/{transaction_id}')
  })

  it('falls back to the concrete request for an unknown path', () => {
    expect(templateFor('GET', '/api/nope')).toBe('GET /api/nope')
  })

  it('knows every operation in the contract', () => {
    const known = new Set(ENDPOINTS)
    expect(contractOperations().filter((op) => !known.has(op))).toEqual([])
  })
})

describe('tie rules', () => {
  it('are documented and attached only to endpoints whose Python order is partial', () => {
    expect(Object.keys(TIE_RULES).sort()).toEqual(['GET /api/reports/by-category', 'GET /api/reports/month/{month}'])
    for (const rules of Object.values(TIE_RULES)) {
      for (const r of rules) expect(r.reason.length).toBeGreaterThan(20)
    }
    expect(normalizeOptionsFor('GET /api/reports/by-category').ties).toHaveLength(1)
    expect(normalizeOptionsFor('GET /api/transactions').ties).toEqual([])
  })
})

describe('NOT_COMPARED', () => {
  it('gives a reason for each skipped endpoint', () => {
    for (const n of NOT_COMPARED) expect(n.reason.length).toBeGreaterThan(10)
    expect(skipped.has('GET /api/settings/config')).toBe(true)
    expect(skipped.has('GET /api/auth/session')).toBe(true)
  })
})
