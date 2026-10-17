/** HTTP to either app, reduced to the Envelope that is compared. */

import type { Envelope } from './diff.ts'
import type { Json } from './normalize.ts'
import type { Api } from './writes.ts'

export function toEnvelope(status: number, contentType: string | null, text: string): Envelope {
  const media = contentType?.split(';')[0]?.trim().toLowerCase() || null
  let body: Json = text === '' ? null : text
  if (text !== '' && media !== null && (media === 'application/json' || media.endsWith('+json'))) {
    try {
      body = JSON.parse(text) as Json
    } catch {
      // Malformed JSON stays text, so the difference shows.
    }
  }
  return { status, contentType: media, body }
}

const TIMEOUT_MS = 60_000

export function makeApi(baseUrl: string): Api {
  return {
    async send(method: string, path: string, body?: Json): Promise<Envelope> {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        return toEnvelope(res.status, res.headers.get('content-type'), await res.text())
      } catch (err) {
        const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)
        return { status: 0, contentType: null, body: `request failed: ${reason}` }
      }
    },
  }
}
