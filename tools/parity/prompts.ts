/**
 * Prompt check (plan 5.10): the TypeScript prompts must be byte-identical to the Python ones.
 * Python's are rendered by dump_prompts.py from api/app/providers/llm/prompts.py; the
 * TypeScript module (server/src/providers/llm/prompts.ts, brief 1D) is imported directly.
 * A missing module or export is a reported difference, never a crash.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { CheckResult } from './report.ts'

export const PROMPT_NAMES = [
  'classify_system_prompt',
  'savings_system_prompt',
  'classify_user_message',
  'savings_user_message',
] as const
export type PromptName = (typeof PROMPT_NAMES)[number]

/** Inputs for the user messages, in the TypeScript shapes (server/src/providers/llm/types.ts). */
export const SAMPLES = {
  merchants: [
    { merchant_key: 'BLUE BOTTLE COFFEE OAKLAND CA', amount_bucket: '<10', direction: 'outflow', account_kind: 'credit' },
    { merchant_key: 'ACME CORP PAYROLL', amount_bucket: '>1000', direction: 'inflow', account_kind: 'checking' },
    { merchant_key: 'CAFÉ LUNA SAN FRANCISCO CA', amount_bucket: '10-50', direction: 'outflow', account_kind: 'credit' },
    { merchant_key: 'PG&E WEB ONLINE', amount_bucket: '50-200', direction: 'outflow', account_kind: 'checking' },
    { merchant_key: 'ZELLE TO', amount_bucket: '200-1000', direction: 'outflow', account_kind: 'savings' },
  ],
  savings: {
    goal_target: 600000,
    months_left: 9,
    monthly_gap: -1250,
    categories: [
      { label: 'Coffee', monthly_totals: [12040, 9805, 0] },
      { label: 'Café "visits"', monthly_totals: [500] },
    ],
    recurring: [
      { category_label: 'TV and movies', amount: 1549, cadence: 'monthly', essentiality: 'discretionary' },
      { category_label: 'Gym', amount: 2499, cadence: 'monthly', essentiality: 'flexible' },
    ],
    excluded_suggestions: [
      'Review your TV and movies subscription (monthly).',
      'Skip the “premium” tier — save $5/month',
    ],
  },
} as const

const money = (cents: number) => {
  const abs = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** The same samples for dump_prompts.py, money as the two-decimal strings Decimal parses. */
export function pythonSamples() {
  const s = SAMPLES.savings
  return {
    merchants: SAMPLES.merchants,
    savings: {
      goal_target: money(s.goal_target),
      months_left: s.months_left,
      monthly_gap: money(s.monthly_gap),
      categories: s.categories.map((c) => ({ label: c.label, monthly_totals: c.monthly_totals.map(money) })),
      recurring: s.recurring.map((r) => ({ ...r, amount: money(r.amount) })),
      excluded_suggestions: s.excluded_suggestions,
    },
  }
}

export function exportCandidates(pythonName: string): string[] {
  const camel = pythonName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  return [camel, pythonName, pythonName.toUpperCase()]
}

const ARGS: Record<PromptName, unknown[]> = {
  classify_system_prompt: [],
  savings_system_prompt: [],
  classify_user_message: [SAMPLES.merchants],
  savings_user_message: [SAMPLES.savings],
}

export type TsPrompt = string | { error: string }

export function collectTsPrompts(mod: Record<string, unknown> | null): Record<PromptName, TsPrompt> {
  const out = {} as Record<PromptName, TsPrompt>
  for (const name of PROMPT_NAMES) {
    if (mod === null) {
      out[name] = { error: 'missing: server/src/providers/llm/prompts.ts does not exist yet (brief 1D)' }
      continue
    }
    const candidates = exportCandidates(name)
    const key = candidates.find((c) => c in mod)
    if (key === undefined) {
      out[name] = { error: `missing export: tried ${candidates.join(', ')}` }
      continue
    }
    const value = mod[key]
    let text: unknown
    try {
      text = typeof value === 'function' ? (value as (...args: unknown[]) => unknown)(...ARGS[name]) : value
    } catch (err) {
      out[name] = { error: `call failed: ${err instanceof Error ? err.message : String(err)}` }
      continue
    }
    out[name] = typeof text === 'string' ? text : { error: `export ${key} returned ${typeof text}, not a string` }
  }
  return out
}

export interface TextDifference {
  index: number
  line: number
  expected: string
  actual: string
}

export function firstDifference(expected: string, actual: string): TextDifference | null {
  if (expected === actual) return null
  let i = 0
  while (i < expected.length && i < actual.length && expected[i] === actual[i]) i++
  const around = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 15), i + 25))
  return { index: i, line: expected.slice(0, i).split('\n').length, expected: around(expected), actual: around(actual) }
}

export function comparePrompts(
  python: Partial<Record<string, string | undefined>>,
  ts: Record<PromptName, TsPrompt>,
): CheckResult[] {
  return PROMPT_NAMES.map((name) => {
    const expected = python[name]
    const actual = ts[name]
    if (expected === undefined) return { name, ok: false, detail: 'the Python dump has no such prompt' }
    if (typeof actual !== 'string') return { name, ok: false, detail: actual.error }
    const d = firstDifference(expected, actual)
    if (d === null) return { name, ok: true, detail: `identical (${expected.length} characters)` }
    return {
      name,
      ok: false,
      detail: `differs at character ${d.index} (line ${d.line}): Python ${d.expected}, TypeScript ${d.actual}`,
    }
  })
}

/** The module's exports, or null when the file does not exist. Import errors propagate. */
export async function loadTsPrompts(file: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(file)) return null
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>
}

const DUMP_SCRIPT = fileURLToPath(new URL('./dump_prompts.py', import.meta.url))

/** Render the Python prompts for the samples with the api/ virtualenv. */
export function dumpPythonPrompts(apiDir: string): Record<string, string> {
  const result = spawnSync('uv', ['run', '--quiet', 'python', DUMP_SCRIPT], {
    cwd: apiDir,
    input: JSON.stringify(pythonSamples()),
    env: { ...process.env, PYTHONPATH: apiDir },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`dump_prompts.py failed: ${result.stderr || result.error?.message}`)
  return JSON.parse(result.stdout) as Record<string, string>
}
