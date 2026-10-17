/**
 * Normalization applied to both responses before they are diffed. Every rule here is a
 * documented, accepted difference between the two apps; anything else is a finding.
 *
 * 1. Timestamps (ISO 8601 with a time and an offset) compare as instants rounded to the
 *    second: Python emits microseconds, JavaScript milliseconds, and either may write UTC
 *    as `Z` or `+00:00`.
 * 2. Wall-clock timestamps (VOLATILE_KEYS) are set from the clock of whichever process wrote
 *    the row, so two apps loaded a few seconds apart can never agree. A valid instant there
 *    becomes VOLATILE_MARK; null, a naive timestamp, or a non-string stays visible.
 * 3. Lists keep their order unless a TieRule says the Python order is only partial. A rule
 *    canonicalizes the order of items whose order key is equal and nothing else.
 * 4. Money and dates stay strings and compare exactly. Object key order never matters
 *    (diff.ts compares objects by key).
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export const VOLATILE_MARK = '<wall-clock timestamp>'

/** Response fields whose value comes from the server clock at write time. */
export const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  'created_at', // rules, goals, suggestions: server_default now()
  'updated_at', // not in any response today; listed so a new field cannot slip through
  'started_at', // sync runs: datetime.now() when the run starts
  'finished_at', // sync runs: datetime.now() when the run ends
  'connected_at', // SimpleFIN connection time
  'next_run_at', // scheduler: now plus the interval (null while the scheduler is off)
])

/** A list whose Python order is total only on `orderBy`; ties are ordered by `tieBreak`. */
export interface TieRule {
  /** JSON pointer into the body; '' is the root and '*' matches any array index. */
  path: string
  orderBy: string
  tieBreak: string
  /** Why the Python order is partial, for the report. */
  reason: string
}

export interface NormalizeOptions {
  volatileKeys?: ReadonlySet<string>
  ties?: readonly TieRule[]
}

const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):?(\d{2}))$/

/** The instant `text` names, rounded half up to the second, as `YYYY-MM-DDTHH:MM:SSZ`. */
export function canonicalInstant(text: string): string | null {
  const m = INSTANT.exec(text)
  if (!m) return null
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  const check = new Date(wall)
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null
  }
  const micros = Number((m[7] ?? '').padEnd(6, '0').slice(0, 6))
  let offsetMinutes = 0
  if (m[8] !== 'Z') {
    const sign = m[9] === '-' ? -1 : 1
    offsetMinutes = sign * (Number(m[10]) * 60 + Number(m[11]))
  }
  // Microseconds since the epoch stay below 2^53 for any date this app sees.
  const totalMicros = (wall - offsetMinutes * 60_000) * 1000 + micros
  const seconds = Math.floor((totalMicros + 500_000) / 1_000_000)
  return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z')
}

function typeRank(value: Json): number {
  if (value === null) return 0
  if (typeof value === 'boolean') return 1
  if (typeof value === 'number') return 2
  if (typeof value === 'string') return 3
  return 4
}

/** A total order over JSON values for tie-breaking: null, booleans, numbers, strings, rest. */
function compareJson(a: Json, b: Json): number {
  const ra = typeRank(a)
  const rb = typeRank(b)
  if (ra !== rb) return ra - rb
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  const sa = typeof a === 'string' ? a : JSON.stringify(a)
  const sb = typeof b === 'string' ? b : JSON.stringify(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

function field(item: Json, key: string): Json {
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) return item[key] ?? null
  return null
}

function orderTies(items: Json[], rule: TieRule): Json[] {
  const out: Json[] = []
  let run: Json[] = []
  let runKey = ''
  const flush = () => {
    out.push(...run.sort((a, b) => compareJson(field(a, rule.tieBreak), field(b, rule.tieBreak))))
    run = []
  }
  for (const item of items) {
    const key = JSON.stringify(field(item, rule.orderBy))
    if (run.length > 0 && key !== runKey) flush()
    runKey = key
    run.push(item)
  }
  flush()
  return out
}

function pathMatches(pattern: string, path: string[]): boolean {
  const parts = pattern === '' ? [] : pattern.split('/').slice(1)
  if (parts.length !== path.length) return false
  return parts.every((part, i) => part === path[i] || (part === '*' && /^\d+$/.test(path[i] ?? '')))
}

export function normalize(value: Json, options: NormalizeOptions = {}): Json {
  const volatile = options.volatileKeys ?? VOLATILE_KEYS
  const ties = options.ties ?? []

  const walk = (node: Json, path: string[], key: string | null): Json => {
    if (typeof node === 'string') {
      const instant = canonicalInstant(node)
      if (instant === null) return node
      return key !== null && volatile.has(key) ? VOLATILE_MARK : instant
    }
    if (Array.isArray(node)) {
      let items = node.map((item, i) => walk(item, [...path, String(i)], null))
      for (const rule of ties) {
        if (pathMatches(rule.path, path)) items = orderTies(items, rule)
      }
      return items
    }
    if (node !== null && typeof node === 'object') {
      const out: { [key: string]: Json } = {}
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, [...path, k], k)
      return out
    }
    return node
  }

  return walk(value, [], null)
}
