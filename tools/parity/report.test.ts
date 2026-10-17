import { describe, expect, it } from 'vitest'
import { type RunReport, exitCode, formatValue, renderReport, summarize } from './report.ts'

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    mode: 'python-vs-typescript',
    actualLabel: 'TypeScript',
    today: '2026-09-30',
    setup: [{ name: 'demo load', ok: true, detail: 'demo sync success: added 295, updated 0' }],
    prompts: [{ name: 'classify_system_prompt', ok: true, detail: 'identical' }],
    cases: [
      { endpoint: 'GET /api/health', label: 'initial', request: 'GET /api/health', differences: [] },
      {
        endpoint: 'GET /api/accounts',
        label: 'initial',
        request: 'GET /api/accounts',
        differences: [{ path: '/status', expected: 200, actual: 501 }],
      },
      {
        endpoint: 'GET /api/accounts',
        label: 'after step 1: recategorize',
        request: 'GET /api/accounts',
        differences: [],
      },
      {
        endpoint: 'GET /api/goals/{goal_id}',
        label: 'initial',
        request: 'GET /api/goals/999999',
        differences: [
          { path: '/body/title', expected: 'Not Found', actual: undefined, note: 'missing' },
          { path: '/body/detail', expected: 'a | b', actual: 'c' },
        ],
      },
    ],
    notCompared: [{ endpoint: 'GET /api/auth/session', reason: 'Python only' }],
    rules: ['Timestamps compare as instants rounded to the second.'],
    ...overrides,
  }
}

describe('summarize', () => {
  it('counts cases and differing cases per endpoint, sorted by path then method', () => {
    const s = summarize(report())
    expect(s.endpoints).toEqual([
      { endpoint: 'GET /api/accounts', cases: 2, differing: 1, differences: 1 },
      { endpoint: 'GET /api/goals/{goal_id}', cases: 1, differing: 1, differences: 2 },
      { endpoint: 'GET /api/health', cases: 1, differing: 0, differences: 0 },
    ])
    expect(s.differingEndpoints).toBe(2)
    expect(s.failedChecks).toBe(0)
    expect(s.clean).toBe(false)
  })

  it('is clean only with no differences and no failed checks', () => {
    const noDiffs = report({
      cases: [{ endpoint: 'GET /api/health', label: 'initial', request: 'GET /api/health', differences: [] }],
    })
    expect(summarize(noDiffs).clean).toBe(true)
    expect(exitCode(noDiffs)).toBe(0)
    const failedSetup = { ...noDiffs, setup: [{ name: 'demo load', ok: false, detail: 'exit 1' }] }
    expect(summarize(failedSetup).clean).toBe(false)
    expect(summarize(failedSetup).failedChecks).toBe(1)
    expect(exitCode(failedSetup)).toBe(1)
    const failedPrompt = { ...noDiffs, prompts: [{ name: 'p', ok: false, detail: 'missing' }] }
    expect(exitCode(failedPrompt)).toBe(1)
  })

  it('exits non-zero when any case differs', () => {
    expect(exitCode(report())).toBe(1)
  })
})

describe('formatValue', () => {
  it('renders JSON in code spans, marks absent values, escapes pipes, truncates', () => {
    expect(formatValue('15.49')).toBe('`"15.49"`')
    expect(formatValue(null)).toBe('`null`')
    expect(formatValue(undefined)).toBe('(missing)')
    expect(formatValue('a | b')).toBe('`"a \\| b"`')
    expect(formatValue('has `tick`')).toBe('`` "has `tick`" ``')
    const long = formatValue('x'.repeat(500))
    expect(long.length).toBeLessThan(200)
    expect(long).toContain('…')
  })
})

describe('renderReport', () => {
  it('starts with the mode, today, and a summary table', () => {
    const md = renderReport(report())
    expect(md).toMatch(/^# Parity report/)
    expect(md).toContain('Python vs TypeScript')
    expect(md).toContain('PLUTUS_TODAY=2026-09-30')
    expect(md).toContain('## Summary')
    expect(md).toContain('| `GET /api/accounts` | 2 | 1 | 1 |')
    expect(md).toContain('| `GET /api/health` | 1 | 0 | 0 |')
    expect(md).toContain('2 of 3 endpoints differ')
  })

  it('lists setup and prompt checks with their outcome', () => {
    const md = renderReport(report({ setup: [{ name: 'demo load', ok: false, detail: 'scripts/demo.ts missing' }] }))
    expect(md).toContain('## Setup')
    expect(md).toContain('| demo load | DIFFERS | scripts/demo.ts missing |')
    expect(md).toContain('## Prompts')
    expect(md).toContain('| classify_system_prompt | same | identical |')
  })

  it('groups differences by endpoint and skips endpoints that match', () => {
    const md = renderReport(report())
    const differences = md.slice(md.indexOf('## Differences'))
    expect(differences).toContain('### `GET /api/accounts`')
    expect(differences).toContain('#### initial: `GET /api/accounts`')
    expect(differences).not.toContain('after step 1: recategorize')
    expect(differences).not.toContain('### `GET /api/health`')
    expect(differences).toContain('| `/status` | `200` | `501` |  |')
    expect(differences).toContain('| `/body/title` | `"Not Found"` | (missing) | missing |')
    expect(differences).toContain('`"a \\| b"`')
  })

  it('caps the rows shown per case', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ path: `/body/${i}`, expected: i, actual: i + 1 }))
    const md = renderReport(
      report({ cases: [{ endpoint: 'GET /api/rules', label: 'initial', request: 'GET /api/rules', differences: many }] }),
      { maxPerCase: 5 },
    )
    expect(md).toContain('| `/body/4` |')
    expect(md).not.toContain('| `/body/5` |')
    expect(md).toContain('25 more differences not shown')
  })

  it('lists what was not compared and the normalization rules', () => {
    const md = renderReport(report())
    expect(md).toContain('## Not compared')
    expect(md).toContain('- `GET /api/auth/session`: Python only')
    expect(md).toContain('## Normalization rules')
    expect(md).toContain('- Timestamps compare as instants rounded to the second.')
  })

  it('says so when nothing differs, labelling a self-check', () => {
    const md = renderReport(
      report({
        mode: 'self-check',
        actualLabel: 'Python (second instance)',
        cases: [{ endpoint: 'GET /api/health', label: 'initial', request: 'GET /api/health', differences: [] }],
      }),
    )
    expect(md).toContain('Self-check: Python vs Python (second instance)')
    expect(md).toContain('No differences.')
    expect(md).toContain('0 of 1 endpoints differ')
  })
})
