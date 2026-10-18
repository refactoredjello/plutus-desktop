/** The markdown report written to tools/parity/report.md, and the run's exit status. */

import type { Difference } from './diff.ts'
import type { Json } from './normalize.ts'

export type Mode = 'python-vs-typescript' | 'self-check'

/** One request compared on both apps. */
export interface CaseResult {
  /** Method and path template, e.g. `GET /api/goals/{goal_id}`. Groups the report. */
  endpoint: string
  /** When it ran: `initial`, or `after step 3: mark one-time`. */
  label: string
  /** The concrete request, e.g. `GET /api/goals/999999`. */
  request: string
  differences: Difference[]
  /** HTTP status on each side; null when that side's request was not sent. */
  statuses?: { expected: number | null; actual: number | null }
}

/** A pass/fail check outside the endpoint diff: app setup, demo load, prompt equality. */
export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

export interface RunReport {
  mode: Mode
  /** How the right-hand app is named in the report. */
  actualLabel: string
  today: string
  setup: CheckResult[]
  prompts: CheckResult[]
  cases: CaseResult[]
  notCompared: { endpoint: string; reason: string }[]
  rules: string[]
}

export interface EndpointSummary {
  endpoint: string
  cases: number
  differing: number
  differences: number
  /** Distinct statuses the Python app answered, ascending: which success and error paths ran. */
  statuses: number[]
}

export interface Summary {
  endpoints: EndpointSummary[]
  differingEndpoints: number
  failedChecks: number
  clean: boolean
}

function sortKey(endpoint: string): string {
  const [method = '', path = ''] = endpoint.split(' ')
  return `${path} ${method}`
}

export function summarize(report: RunReport): Summary {
  const by = new Map<string, EndpointSummary>()
  for (const c of report.cases) {
    const s = by.get(c.endpoint) ?? { endpoint: c.endpoint, cases: 0, differing: 0, differences: 0, statuses: [] }
    s.cases += 1
    const status = c.statuses?.expected
    if (typeof status === 'number' && !s.statuses.includes(status)) {
      s.statuses.push(status)
      s.statuses.sort((a, b) => a - b)
    }
    if (c.differences.length > 0) s.differing += 1
    s.differences += c.differences.length
    by.set(c.endpoint, s)
  }
  const endpoints = [...by.values()].sort((a, b) => (sortKey(a.endpoint) < sortKey(b.endpoint) ? -1 : 1))
  const differingEndpoints = endpoints.filter((e) => e.differing > 0).length
  const failedChecks = [...report.setup, ...report.prompts].filter((c) => !c.ok).length
  return { endpoints, differingEndpoints, failedChecks, clean: differingEndpoints === 0 && failedChecks === 0 }
}

export function exitCode(report: RunReport): 0 | 1 {
  return summarize(report).clean ? 0 : 1
}

const MAX_VALUE = 120

/** A value as a markdown table cell: JSON in a code span, `(missing)` when absent. */
export function formatValue(value: Json | undefined): string {
  if (value === undefined) return '(missing)'
  let text = JSON.stringify(value)
  if (text.length > MAX_VALUE) text = `${text.slice(0, MAX_VALUE)}…`
  text = text.replaceAll('|', '\\|')
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``
}

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ')

export function renderReport(report: RunReport, options: { maxPerCase?: number } = {}): string {
  const maxPerCase = options.maxPerCase ?? 25
  const summary = summarize(report)
  const lines: string[] = []
  const title =
    report.mode === 'self-check'
      ? `Self-check: Python vs ${report.actualLabel}`
      : `Python vs ${report.actualLabel}`

  lines.push('# Parity report', '')
  lines.push(`${title}, PLUTUS_TODAY=${report.today}. Python is the oracle ("expected").`, '')

  lines.push('## Summary', '')
  lines.push(
    `${summary.differingEndpoints} of ${summary.endpoints.length} endpoints differ; ` +
      `${summary.failedChecks} setup or prompt checks differ. ` +
      (summary.clean ? 'Clean.' : 'Not clean: exit status 1.'),
    '',
  )
  lines.push('| Endpoint | Cases | Differing cases | Differences | Python statuses |', '|---|---|---|---|---|')
  for (const e of summary.endpoints) {
    lines.push(`| \`${e.endpoint}\` | ${e.cases} | ${e.differing} | ${e.differences} | ${e.statuses.join(', ')} |`)
  }
  lines.push('')

  const checks = (heading: string, items: CheckResult[]) => {
    lines.push(`## ${heading}`, '')
    if (items.length === 0) {
      lines.push('None.', '')
      return
    }
    lines.push('| Check | Result | Detail |', '|---|---|---|')
    for (const c of items) lines.push(`| ${cell(c.name)} | ${c.ok ? 'same' : 'DIFFERS'} | ${cell(c.detail)} |`)
    lines.push('')
  }
  checks('Setup', report.setup)
  checks('Prompts', report.prompts)

  const steps = report.cases.filter((c) => c.label.startsWith('step '))
  if (steps.length > 0) {
    const status = (n: number | null | undefined) => (n === null || n === undefined ? 'not sent' : String(n))
    lines.push('## Write steps', '')
    lines.push(`| Step | Request | Python | ${report.actualLabel} | Result |`, '|---|---|---|---|---|')
    for (const c of steps) {
      lines.push(
        `| ${cell(c.label)} | \`${c.request}\` | ${status(c.statuses?.expected)} | ` +
          `${status(c.statuses?.actual)} | ${c.differences.length === 0 ? 'same' : 'DIFFERS'} |`,
      )
    }
    lines.push('')
  }

  lines.push('## Differences', '')
  const differing = report.cases.filter((c) => c.differences.length > 0)
  if (differing.length === 0) lines.push('No differences.', '')
  for (const e of summary.endpoints.filter((s) => s.differing > 0)) {
    lines.push(`### \`${e.endpoint}\``, '')
    for (const c of differing.filter((d) => d.endpoint === e.endpoint)) {
      lines.push(`#### ${c.label}: \`${c.request}\``, '')
      lines.push(`| Path | Python | ${report.actualLabel} | Note |`, '|---|---|---|---|')
      for (const d of c.differences.slice(0, maxPerCase)) {
        lines.push(
          `| \`${d.path || '/'}\` | ${formatValue(d.expected)} | ${formatValue(d.actual)} | ${cell(d.note ?? '')} |`,
        )
      }
      const hidden = c.differences.length - maxPerCase
      if (hidden > 0) lines.push('', `${hidden} more differences not shown.`)
      lines.push('')
    }
  }

  lines.push('## Not compared', '')
  for (const n of report.notCompared) lines.push(`- \`${n.endpoint}\`: ${n.reason}`)
  if (report.notCompared.length === 0) lines.push('Nothing.')
  lines.push('')

  lines.push('## Normalization rules', '')
  for (const r of report.rules) lines.push(`- ${r}`)
  lines.push('')
  return lines.join('\n')
}
