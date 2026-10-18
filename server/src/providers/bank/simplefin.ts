/**
 * SimpleFIN Bridge adapter. Protocol: https://www.simplefin.org/protocol.html
 *
 * Budget: 24 requests/day. The docs allow 90 days per request, but the live bridge warns above
 * 45 days and says it may cap there, so `fetch` issues one request per 45-day chunk and never
 * retries. The access URL embeds credentials and must never be logged.
 *
 * HTTP goes through an injected `fetch` (tests pass a stub). Redirects are never followed
 * (`redirect: 'manual'`), so credentials never travel to another host. The JSON a bridge sends
 * is loosely typed, so the helpers below coerce any JSON value to text, an integer, an amount,
 * or a truth value by one fixed set of rules, and describe a bad value the same way in errors.
 */

import type { AccountType } from '../../db/schema.js'
import { type PlainDate, addDays, daysBetween, epochToTimestamp, epochToUtcDate, plainDate, utcNow } from '../../lib/dates.js'
import { ProviderError } from '../../lib/errors.js'
import { type Cents, parseMoney } from '../../lib/money.js'
import type { BankProvider, ProviderAccount, ProviderSnapshot, ProviderTransaction } from './types.js'

export const PROVIDER_NAME = 'simplefin'
export const MAX_WINDOW_DAYS = 45
export const TIMEOUT_SECONDS = 30

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

// --- Coercing JSON values -------------------------------------------------------------------

/** Whitespace for stripping: ASCII whitespace, \x1c-\x1f, and the Unicode spaces. */
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g')

/** Strip PY_SPACE from both ends. */
function pyStrip(text: string): string {
  return text.replace(PY_STRIP, '')
}

/** False for null, false, 0, "", [], and {}; true otherwise. */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

const NONPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u

/** A string quoted and escaped for an error message: single quotes unless it holds one. */
function pyReprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'"
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) as number
    if (ch === quote || ch === '\\') out += `\\${ch}`
    else if (ch === '\t') out += '\\t'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch !== ' ' && NONPRINTABLE.test(ch)) {
      if (code < 0x100) out += `\\x${code.toString(16).padStart(2, '0')}`
      else if (code < 0x10000) out += `\\u${code.toString(16).padStart(4, '0')}`
      else out += `\\U${code.toString(16).padStart(8, '0')}`
    } else out += ch
  }
  return `${quote}${out}${quote}`
}

/**
 * A number for an error message: shortest round-trip digits, ".0" on integral floats and
 * exponents past 1e16. JSON.parse cannot tell 1.0 from 1, so integral values print as ints.
 */
function pyReprNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return String(value)
  const [mantissa = '', exp = '0'] = value.toExponential().split('e')
  const e = Number(exp)
  if (e < -4 || e >= 16) return `${mantissa}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`
  const fixed = String(value)
  return fixed.includes('.') ? fixed : `${fixed}.0`
}

/** Any JSON value for an error message: None/True/False, quoted strings, lists, and dicts. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'string') return pyReprString(value)
  if (typeof value === 'number') return pyReprNumber(value)
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`
  const entries = Object.entries(value as Record<string, unknown>)
  return `{${entries.map(([k, v]) => `${pyReprString(k)}: ${pyRepr(v)}`).join(', ')}}`
}

/** A JSON value as text: strings as they are, anything else as pyRepr shows it. */
function pyStr(value: unknown): string {
  return typeof value === 'string' ? value : pyRepr(value)
}

/** The items of a JSON value: list items, string characters, or object keys. */
function pyIter(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return Array.from(value)
  if (value !== null && typeof value === 'object') return Object.keys(value)
  throw new TypeError(`${pyRepr(value)} is not iterable`)
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The value as an object; anything else is an error. */
function asDict(value: unknown): JsonObject {
  if (!isObject(value)) throw new TypeError(`${pyRepr(value)} has no attribute 'get'`)
  return value
}

/** `raw[key]`; an error when the key is missing. */
function requireKey(raw: JsonObject, key: string): unknown {
  if (!Object.hasOwn(raw, key)) throw new Error(`KeyError: ${pyReprString(key)}`)
  return raw[key]
}

/** `raw[key]`, or the fallback only when the key is absent, not when it is null. */
function get(raw: JsonObject, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : fallback
}

/** Map Unicode decimal digits to ASCII, so any script's digits parse as numbers. */
function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (ch) => {
    // Unicode encodes every decimal digit set as a contiguous run 0-9, so a digit's value is
    // its offset from the start of its run of digits, modulo 10.
    let start = ch.codePointAt(0) as number
    while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1
    return String(((ch.codePointAt(0) as number) - start) % 10)
  })
}

/** An integer from what a bridge may send as a timestamp: a number, a boolean, or digit text. */
function pyInt(value: unknown): number {
  if (typeof value === 'number') return Math.trunc(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const text = asciiDigits(pyStrip(value))
    if (/^[+-]?\d+(?:_\d+)*$/.test(text)) return Number(text.replaceAll('_', ''))
    throw new Error(`ValueError: invalid literal for int() with base 10: ${pyReprString(value)}`)
  }
  throw new TypeError(`int() argument must be a string or a number, not ${pyRepr(value)}`)
}

const DECIMAL = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/

/**
 * Decimal text (an optional exponent, "_" separators, any script's digits) to cents, rounding
 * extra places half away from zero (stored amounts' rule). Returns null for anything else,
 * including Infinity and NaN.
 */
function decimalToCents(text: string): Cents | null {
  const match = DECIMAL.exec(asciiDigits(pyStrip(text.replaceAll('_', ''))))
  if (!match) return null
  const [, sign = '', whole = '', frac = '', onlyFrac = '', exp = '0'] = match
  const digits = `${whole}${whole ? frac : onlyFrac}`
  const point = (whole ? whole.length : 0) + Number(exp)
  if (point < -3) return parseMoney('0')
  if (point > 20) throw new RangeError(`Money amount out of range: ${JSON.stringify(text)}`)
  const padded = point > digits.length ? digits.padEnd(point, '0') : point < 0 ? `${'0'.repeat(-point)}${digits}` : digits
  const at = Math.max(point, 0)
  return parseMoney(`${sign}${padded.slice(0, at) || '0'}.${padded.slice(at)}`)
}

// --- Base64 and URL schemes -----------------------------------------------------------------

class Base64Error extends Error {}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Lenient base64: characters outside the alphabet are discarded; padding ends the data. */
function a2bBase64(data: string): Uint8Array {
  const out: number[] = []
  let quad = 0
  let left = 0
  let pads = 0
  for (const ch of data) {
    if (ch === '=') {
      pads += 1
      if (quad >= 2 && quad + pads >= 4) return Uint8Array.from(out)
      continue
    }
    const value = B64.indexOf(ch)
    if (value < 0) continue
    pads = 0
    if (quad === 0) {
      left = value
      quad = 1
    } else if (quad === 1) {
      out.push(((left << 2) | (value >> 4)) & 0xff)
      left = value & 0x0f
      quad = 2
    } else if (quad === 2) {
      out.push(((left << 4) | (value >> 2)) & 0xff)
      left = value & 0x03
      quad = 3
    } else {
      out.push(((left << 6) | value) & 0xff)
      left = 0
      quad = 0
    }
  }
  if (quad !== 0) throw new Base64Error(quad === 1 ? 'Invalid base64-encoded string' : 'Incorrect padding')
  return Uint8Array.from(out)
}

/** Base64 in either the standard or the URL-safe alphabet; ASCII only. */
function b64decodeUrlsafe(text: string): Uint8Array {
  if (Array.from(text).some((ch) => ch.charCodeAt(0) > 0x7f)) throw new Base64Error('string argument should contain only ASCII characters')
  return a2bBase64(text.replaceAll('-', '+').replaceAll('_', '/'))
}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]*$/

/** The URL's scheme, lower-cased, after leading control characters and tabs or newlines are removed; "" when none. */
function urlScheme(url: string): string {
  let start = 0
  while (start < url.length && url.charCodeAt(start) <= 0x20) start += 1
  const cleaned = url.slice(start).replace(/[\t\r\n]/g, '')
  const i = cleaned.indexOf(':')
  if (i > 0 && /^[A-Za-z]/.test(cleaned) && SCHEME_CHARS.test(cleaned.slice(0, i))) {
    return cleaned.slice(0, i).toLowerCase()
  }
  return ''
}

function isHttpUrl(url: string): boolean {
  const scheme = urlScheme(url)
  return scheme === 'http' || scheme === 'https'
}

/** The name a fetch failure is reported by: ReadTimeout, ConnectError, or ReadError. */
function httpxErrorName(error: unknown, phase: 'connect' | 'read'): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'ReadTimeout'
  return phase === 'connect' ? 'ConnectError' : 'ReadError'
}

// --- Public API ------------------------------------------------------------------------------

/** Exchange a one-time setup token for an access URL (a claim works only once). */
export async function claimSetupToken(token: string, fetchFn: FetchFn = globalThis.fetch): Promise<string> {
  let claimUrl: string
  try {
    const stripped = pyStrip(token)
    const padded = stripped + '='.repeat((4 - (Array.from(stripped).length % 4)) % 4)
    const bytes = b64decodeUrlsafe(padded)
    claimUrl = pyStrip(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    throw new ProviderError('The SimpleFIN setup token is not valid base64.')
  }
  if (!isHttpUrl(claimUrl)) {
    throw new ProviderError('The SimpleFIN setup token does not contain a claim URL.')
  }
  let status: number
  let text: string
  try {
    const response = await fetchFn(claimUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000),
    })
    status = response.status
    text = await response.text()
  } catch {
    throw new ProviderError('Could not reach SimpleFIN to claim the setup token.')
  }
  if (status !== 200) {
    throw new ProviderError(
      `SimpleFIN rejected the setup token (HTTP ${status}). A token can be claimed only once; create a new one.`,
    )
  }
  const accessUrl = pyStrip(text)
  if (!isHttpUrl(accessUrl)) {
    throw new ProviderError('SimpleFIN returned an unexpected access URL.')
  }
  return accessUrl
}

/** SimpleFIN does not report account type, so guess from the account name. */
export function inferAccountType(name: string): AccountType {
  const lowered = name.toLowerCase()
  if (['card', 'visa', 'mastercard', 'amex', 'credit'].some((w) => lowered.includes(w))) return 'credit'
  if (lowered.includes('saving')) return 'savings'
  if (lowered.includes('checking')) return 'checking'
  return 'other'
}

/** `_ts`: a positive Unix timestamp in seconds, else null. */
function ts(value: unknown): number | null {
  const seconds = pyTruthy(value) ? pyInt(value) : 0
  return seconds > 0 ? seconds : null
}

function decimal(value: unknown): Cents {
  const text = pyStr(value)
  const parsed = decimalToCents(text)
  if (parsed === null) throw new ProviderError(`SimpleFIN returned a non-numeric amount: ${pyRepr(value)}`)
  return parsed
}

/** Inclusive, non-overlapping day ranges of at most MAX_WINDOW_DAYS days. */
export function chunkRanges(start: PlainDate, end: PlainDate): [PlainDate, PlainDate][] {
  const out: [PlainDate, PlainDate][] = []
  let cursor = start
  while (cursor <= end) {
    const candidate = addDays(cursor, MAX_WINDOW_DAYS - 1)
    const chunkEnd = candidate < end ? candidate : end
    out.push([cursor, chunkEnd])
    cursor = addDays(chunkEnd, 1)
  }
  return out
}

function midnightUnix(day: PlainDate): number {
  return daysBetween(plainDate('1970-01-01'), day) * 86400
}

/** A text field: the value as text when truthy, else null. */
function optionalText(value: unknown): string | null {
  return pyTruthy(value) ? pyStr(value) : null
}

export class SimpleFINProvider implements BankProvider {
  readonly name = PROVIDER_NAME
  /** Read by the sync service for the daily budget. */
  requestsMade = 0
  private readonly baseUrl: string | null
  private readonly authorization: string
  private readonly fetchFn: FetchFn

  constructor(accessUrl: string, fetchFn: FetchFn = globalThis.fetch) {
    let parts: URL | null = null
    try {
      parts = new URL(accessUrl)
    } catch {
      parts = null
    }
    if (parts && (parts.protocol === 'http:' || parts.protocol === 'https:')) {
      const netloc = parts.port ? `${parts.hostname}:${parts.port}` : parts.hostname
      this.baseUrl = `${parts.protocol}//${netloc}${parts.pathname.replace(/\/+$/, '')}`
      this.authorization = `Basic ${Buffer.from(`${parts.username}:${parts.password}`, 'utf8').toString('base64')}`
    } else {
      // A URL that is not http(s) fails at request time; the constructor never fails.
      this.baseUrl = null
      this.authorization = ''
    }
    this.fetchFn = fetchFn
  }

  async fetch(start: PlainDate, end: PlainDate): Promise<ProviderSnapshot> {
    const accounts = new Map<string, ProviderAccount>()
    const errors: string[] = []
    for (const [chunkStart, chunkEnd] of chunkRanges(start, end)) {
      const payload = await this.request(chunkStart, chunkEnd)
      for (const err of pyIter(pyTruthy(get(payload, 'errors')) ? get(payload, 'errors') : [])) {
        const text = pyStr(err)
        if (!errors.includes(text)) errors.push(text)
      }
      for (const raw of pyIter(pyTruthy(get(payload, 'accounts')) ? get(payload, 'accounts') : [])) {
        const parsed = parseAccount(asDict(raw), chunkEnd)
        const existing = accounts.get(parsed.external_id)
        accounts.set(parsed.external_id, existing === undefined ? parsed : merge(existing, parsed))
      }
    }
    return { accounts: [...accounts.values()], errors }
  }

  private async request(start: PlainDate, end: PlainDate): Promise<JsonObject> {
    const params = new URLSearchParams({
      'start-date': String(midnightUnix(start)),
      'end-date': String(midnightUnix(addDays(end, 1))),
      pending: '1',
    })
    this.requestsMade += 1
    if (this.baseUrl === null) throw new ProviderError('Could not reach SimpleFIN: UnsupportedProtocol')
    let response: Response
    let body: string
    let phase: 'connect' | 'read' = 'connect'
    try {
      response = await this.fetchFn(`${this.baseUrl}/accounts?${params}`, {
        headers: { authorization: this.authorization },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000),
      })
      phase = 'read'
      body = await response.text()
    } catch (error) {
      throw new ProviderError(`Could not reach SimpleFIN: ${httpxErrorName(error, phase)}`)
    }
    if (response.status !== 200) throw new ProviderError(`SimpleFIN returned HTTP ${response.status}.`)
    let data: unknown
    try {
      data = JSON.parse(body)
    } catch {
      throw new ProviderError('SimpleFIN returned a response that is not JSON.')
    }
    if (!isObject(data)) throw new ProviderError('SimpleFIN returned an unexpected response shape.')
    return data
  }
}

function parseAccount(raw: JsonObject, windowEnd: PlainDate): ProviderAccount {
  const org = asDict(pyTruthy(get(raw, 'org')) ? get(raw, 'org') : {})
  const available = get(raw, 'available-balance')
  const transactions = pyIter(pyTruthy(get(raw, 'transactions')) ? get(raw, 'transactions') : []).map((t) =>
    parseTransaction(asDict(t), windowEnd),
  )
  const orgName = get(org, 'name')
  const institution = pyTruthy(orgName) ? orgName : get(org, 'domain')
  const balanceDate = ts(get(raw, 'balance-date'))
  return {
    external_id: pyStr(requireKey(raw, 'id')),
    name: pyStr(pyTruthy(get(raw, 'name')) ? get(raw, 'name') : requireKey(raw, 'id')),
    type: inferAccountType(pyStr(pyTruthy(get(raw, 'name')) ? get(raw, 'name') : '')),
    institution_name: institution === null ? null : pyStr(institution),
    currency: Array.from(pyStr(pyTruthy(get(raw, 'currency')) ? get(raw, 'currency') : 'USD'))
      .slice(0, 3)
      .join('')
      .toUpperCase(),
    balance: decimal(get(raw, 'balance', '0')),
    available: available === null || available === '' ? null : decimal(available),
    balance_as_of: balanceDate === null ? utcNow() : epochToTimestamp(balanceDate),
    transactions,
  }
}

/** Combine the same account from two chunks: newest balance, deduplicated transactions. */
function merge(first: ProviderAccount, later: ProviderAccount): ProviderAccount {
  const seen = new Map<string, ProviderTransaction>(first.transactions.map((t) => [t.external_id, t]))
  for (const t of later.transactions) seen.set(t.external_id, t)
  const newest = later.balance_as_of >= first.balance_as_of ? later : first
  return { ...newest, transactions: [...seen.values()] }
}

function parseTransaction(raw: JsonObject, windowEnd: PlainDate): ProviderTransaction {
  const posted = ts(get(raw, 'posted'))
  const transactedAt = ts(get(raw, 'transacted_at'))
  const pending = pyTruthy(get(raw, 'pending')) || posted === null
  let postedOn: PlainDate
  if (posted !== null) postedOn = epochToUtcDate(posted)
  else postedOn = transactedAt !== null ? epochToUtcDate(transactedAt) : windowEnd // pending: no posting date yet
  return {
    external_id: pyStr(requireKey(raw, 'id')),
    posted_on: postedOn,
    amount: decimal(get(raw, 'amount', '0')),
    description: pyStr(pyTruthy(get(raw, 'description')) ? get(raw, 'description') : ''),
    payee: optionalText(get(raw, 'payee')),
    memo: optionalText(get(raw, 'memo')),
    pending,
    transacted_at: transactedAt === null ? null : epochToTimestamp(transactedAt),
  }
}
