/**
 * Structural diff of two JSON values. `expected` is always the Python app (the oracle);
 * `actual` is the TypeScript server, or a second Python app in self-check mode.
 */

import { type Json, type NormalizeOptions, normalize } from './normalize.ts'

export interface Difference {
  /** JSON pointer to the differing value ('' for the root). */
  path: string
  /** undefined means the value is absent on that side. */
  expected: Json | undefined
  actual: Json | undefined
  note?: string
}

/** One HTTP response reduced to what is compared. */
export interface Envelope {
  status: number
  /** Media type without parameters, or null when the response has none. */
  contentType: string | null
  /** Parsed JSON for JSON responses, else the text, else null for an empty body. */
  body: Json
}

type Kind = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object'

function kind(value: Json): Kind {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value as Kind
}

const escapeKey = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1')

export function diff(expected: Json, actual: Json, path = ''): Difference[] {
  const ke = kind(expected)
  const ka = kind(actual)
  if (ke !== ka) return [{ path, expected, actual, note: `type ${ke} vs ${ka}` }]

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const out: Difference[] = []
    if (expected.length !== actual.length) {
      out.push({ path, expected: expected.length, actual: actual.length, note: 'array length' })
    }
    const length = Math.max(expected.length, actual.length)
    for (let i = 0; i < length; i++) {
      const p = `${path}/${i}`
      if (i >= actual.length) out.push({ path: p, expected: expected[i], actual: undefined, note: 'missing' })
      else if (i >= expected.length) out.push({ path: p, expected: undefined, actual: actual[i], note: 'unexpected' })
      else out.push(...diff(expected[i] as Json, actual[i] as Json, p))
    }
    return out
  }

  if (ke === 'object') {
    const e = expected as { [key: string]: Json }
    const a = actual as { [key: string]: Json }
    const out: Difference[] = []
    for (const key of Object.keys(e)) {
      const p = `${path}/${escapeKey(key)}`
      if (!Object.hasOwn(a, key)) out.push({ path: p, expected: e[key], actual: undefined, note: 'missing' })
      else out.push(...diff(e[key] as Json, a[key] as Json, p))
    }
    for (const key of Object.keys(a)) {
      if (!Object.hasOwn(e, key)) {
        out.push({ path: `${path}/${escapeKey(key)}`, expected: undefined, actual: a[key], note: 'unexpected' })
      }
    }
    return out
  }

  // === rather than Object.is: Python prints a float ratio as -0.0 where JavaScript prints 0.
  return expected === actual ? [] : [{ path, expected, actual }]
}

/** Normalize both responses (normalize.ts) and diff status, content type, and body. */
export function compareResponses(
  expected: Envelope,
  actual: Envelope,
  options: NormalizeOptions = {},
): Difference[] {
  const shape = (r: Envelope): Json => ({
    status: r.status,
    content_type: r.contentType,
    body: normalize(r.body, options),
  })
  // Tie rules address the body, so normalize the body on its own before wrapping it.
  return diff(shape(expected), shape(actual))
}
