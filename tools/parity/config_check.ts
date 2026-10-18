/**
 * GET /api/settings/config is new in the desktop contract (0B), so there is no Python answer
 * to diff. Instead the TypeScript answer is checked against what it must be: the env both
 * apps were started with, plus the oracle's own GET /api/settings/llm and /api/sync/schedule.
 */

import type { Envelope } from './diff.ts'
import type { Json } from './normalize.ts'
import type { CheckResult } from './report.ts'

export const CONFIG_PATH = '/api/settings/config'
const NAME = 'runtime config (TypeScript only)'

type Obj = { [key: string]: Json }
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

export function expectedConfig(env: Readonly<Record<string, string>>, llm: unknown, schedule: unknown): Obj | null {
  if (!isObj(llm) || typeof llm.provider !== 'string' || typeof llm.model !== 'string') return null
  if (!isObj(schedule) || typeof schedule.enabled !== 'boolean' || typeof schedule.interval_hours !== 'number') return null
  return {
    llm_provider: llm.provider,
    llm_model: llm.model,
    anthropic_api_key_set: Boolean(env.ANTHROPIC_API_KEY),
    ollama_base_url: env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    owner_name_tokens: JSON.parse(env.OWNER_NAME_TOKENS ?? '[]') as Json,
    sync_interval_hours: schedule.interval_hours,
    sync_first_history_days: Number(env.SYNC_FIRST_HISTORY_DAYS ?? '180'),
    scheduler_enabled: schedule.enabled,
  }
}

export function configCheck(expected: Obj | null, actual: Envelope): CheckResult {
  if (expected === null) return { name: NAME, ok: false, detail: 'the Python answers needed for the expectation were not usable' }
  if (actual.status !== 200 || !isObj(actual.body)) {
    return { name: NAME, ok: false, detail: `GET ${CONFIG_PATH} answered ${actual.status}: ${JSON.stringify(actual.body)}` }
  }
  const body = actual.body
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(body)])].sort()
  const diffs = keys.flatMap((k) => {
    const e = JSON.stringify(expected[k])
    const a = JSON.stringify(body[k])
    return e === a ? [] : [`${k}: expected ${e ?? '(missing)'}, got ${a ?? '(missing)'}`]
  })
  return diffs.length === 0
    ? { name: NAME, ok: true, detail: `GET ${CONFIG_PATH} matches the seeded env` }
    : { name: NAME, ok: false, detail: diffs.join('; ') }
}
