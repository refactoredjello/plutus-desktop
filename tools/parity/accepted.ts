/**
 * Differences brief 4A accepts on purpose, applied to both responses before they are diffed.
 * Each class is named in the report (ACCEPTED_NOTES) and in docs/PARITY_4A.md for Fable
 * checkpoint B. Anything not listed here is a finding.
 */

import type { Envelope } from './diff.ts'
import type { Json } from './normalize.ts'

/** The media type both validation shapes are reduced to; never sent by either app. */
export const VALIDATION_MEDIA = '<422 validation error>'

export const ACCEPTED_NOTES: readonly string[] = [
  'Accepted, 422 validation bodies: FastAPI answers `application/json` `{"detail": [{loc, msg, ...}]}`, ' +
    'the port `application/problem+json` with a `detail` string "<location>.<path>: <message>; ..." ' +
    '(DESKTOP_PLAN.md 5.5, on purpose). Both are reduced to the sorted list of failing fields ' +
    '(`body.name`, `query.months`; a key Zod names in `Unrecognized key: "colour"` counts as ' +
    '`body.colour`, where FastAPI reports it), so the status and the fields are still compared; ' +
    'messages are not.',
  'Accepted, empty 204 media type: FastAPI sends `Content-Type: application/json` on a 204 with no ' +
    'body, the port sends none (RFC 9110: a 204 has no content). The media type of an empty 204 is ' +
    'dropped on both sides; the status and the empty body are still compared.',
]

type Obj = { [key: string]: Json }
const isObj = (v: Json | undefined): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

const sortedUnique = (items: string[]) => [...new Set(items)].sort()

function fastapiFields(body: Json): string[] | null {
  if (!isObj(body) || Object.keys(body).length !== 1 || !Array.isArray(body.detail)) return null
  const fields: string[] = []
  for (const item of body.detail) {
    if (!isObj(item) || !Array.isArray(item.loc) || item.loc.length === 0) return null
    fields.push(item.loc.map(String).join('.'))
  }
  return sortedUnique(fields)
}

function problemFields(body: Json): string[] | null {
  if (!isObj(body) || body.title !== 'Validation error' || body.status !== 422) return null
  if (typeof body.detail !== 'string') return null
  const fields = body.detail.split('; ').flatMap((part) => {
    const colon = part.indexOf(': ')
    if (colon === -1) return [part]
    const location = part.slice(0, colon)
    // Zod reports an unknown key at its object and names it in the message; FastAPI at the key.
    const unknown = /^Unrecognized keys?: (.+)$/.exec(part.slice(colon + 2))
    if (unknown === null) return [location]
    return [...(unknown[1] ?? '').matchAll(/"([^"]*)"/g)].map((m) => `${location}.${m[1]}`)
  })
  return sortedUnique(fields)
}

/** The failing fields of a 422 validation response in either app's shape, else null. */
export function validationFields(r: Envelope): string[] | null {
  if (r.status !== 422) return null
  if (r.contentType === 'application/json') return fastapiFields(r.body)
  if (r.contentType === 'application/problem+json') return problemFields(r.body)
  return null
}

/** The envelope with the accepted classes reduced to a shape both apps share. */
export function acceptEnvelope(r: Envelope): Envelope {
  const fields = validationFields(r)
  if (fields !== null) return { status: 422, contentType: VALIDATION_MEDIA, body: { invalid: fields } }
  if (r.status === 204 && r.body === null) return { ...r, contentType: null }
  return r
}
