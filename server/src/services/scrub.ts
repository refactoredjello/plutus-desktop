/**
 * Privacy boundary for categorization.
 *
 * Everything that may reach an LLM about a transaction is produced here: a normalized,
 * scrubbed merchant key, a coarse amount bucket, a direction, and an account kind.
 * Invariant: a key never contains a run of more than 3 digits nor any owner name token.
 *
 * Bank text is not ASCII-only, and JavaScript `RegExp` classes are, so the patterns below
 * spell out Unicode-aware classes (all with the `u` flag):
 * - A digit is any Unicode decimal digit: `\p{Nd}` (JavaScript `\d` is ASCII only).
 * - A word character is any Unicode letter or number or `_`: `[\p{L}\p{N}_]`, and a word
 *   boundary is rebuilt from lookarounds over that class (JavaScript `\b` is ASCII only, even
 *   with `u`).
 * - Whitespace (for patterns, splitting, and stripping) includes U+001C..U+001F and U+0085 and
 *   excludes U+FEFF, unlike JavaScript `\s` and trim().
 * - "Any character" excludes only `\n`: `[^\n]` (JavaScript `.` also excludes `\r`, U+2028,
 *   U+2029).
 * - Lengths and slices count code points, not UTF-16 units.
 * `$` is left as is: the key is whitespace-collapsed before any pattern runs, so it never
 * contains a newline.
 * The classes follow Unicode 16; they may differ on characters a newer Unicode version adds.
 */

import type { AccountType } from '../db/schema.js'
import type { Cents } from '../lib/money.js'
import type { AccountKind, AmountBucket, MerchantInput } from '../providers/llm/types.js'

export const MAX_KEY_LENGTH = 200
export const EMPTY_KEY = 'UNKNOWN'

const WORD = String.raw`[\p{L}\p{N}_]`
const B = String.raw`(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`
const D = String.raw`\p{Nd}`
const SPACE_CHARS = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`
const S = `[${SPACE_CHARS}]`
const ANY = String.raw`[^\n]`

const re = (source: string): RegExp => new RegExp(source, 'gu')

// Processor prefixes that hide the real merchant behind a gateway ("SQ *", "TST*", "PP*").
const PROCESSOR_PREFIX = re(String.raw`^(?:SQC|SQ|TST|PP|PAYPAL|SP|CKO)${S}*\*${S}*`)

// Counterparty names must never leave the machine: keep the rail, drop whoever follows.
const ZELLE = re(String.raw`${B}ZELLE${B}(?:${S}+(?:PAYMENT|TRANSFER))?${S}+(TO|FROM)${B}${ANY}*$`)
const VENMO = re(
  String.raw`${B}VENMO${B}(?:${S}+(PAYMENT|CASHOUT|CASH OUT|TRANSFER|ADD MONEY))?${B}${ANY}*$`,
)

// Other person-to-person rails: keep the rail (and TO/FROM or SENT/RECEIVED), drop the rest.
// Known limitation: "PAYPAL *<name>" is not handled. PayPal merchant names are useful for
// classification and a person cannot be told apart from a merchant, so the name is kept.
const WIRE = re(
  String.raw`${B}(?:(?:INCOMING|OUTGOING)${S}+)?WIRE${B}(?:${S}+(?:TRANSFER|PAYMENT))?(?:${S}+(TO|FROM)${B})?${ANY}*$`,
)
const CASH_APP = re(String.raw`${B}CASH${S}*APP${B}(?:${S}+TRANSFER)?(?:${S}+(TO|FROM)${B})?${ANY}*$`)
const APPLE_CASH = re(String.raw`${B}APPLE${S}+CASH${B}(?:${S}+(SENT|RECEIVED)${B})?${ANY}*$`)
const PAYPAL_INSTANT = re(String.raw`${B}PAYPAL${S}+(INST${S}+XFER|INSTANT${S}+TRANSFER)${B}${ANY}*$`)
const BANK_TRANSFER = re(
  String.raw`${B}((?:ONLINE${S}+|MOBILE${S}+)?(?:TRANSFER|XFER))${S}+(TO|FROM)${B}${ANY}*$`,
)

// Markers after which everything is reference data (ACH ids, confirmation numbers, memos).
const TRAILING_REFERENCE = re(
  String.raw`${B}(?:PPD|WEB|CCD|CTX|TEL)${S}+ID${B}${ANY}*$` +
    String.raw`|${B}CONF(?:IRMATION)?${S}*(?:#|NO${B}|NUM${B})${ANY}*$` +
    String.raw`|${B}REF(?:ERENCE)?${S}*(?:#|NO${B}|NUM${B})${ANY}*$` +
    String.raw`|${B}TRACE${S}*(?:#|NO${B})${ANY}*$`,
)

const STAR_REFERENCE = re(String.raw`\*${S}*[A-Z0-9]*${D}[A-Z0-9]*`) // "*2K4LM9TQ1"
const NUMBER_SIGN = re(String.raw`#${S}*[A-Z0-9\-]+`) // store numbers, "CHECK # 1042"
const MASKED_ACCOUNT = re(String.raw`(?:\.{2,}|${B}X{2,}|\*{2,})${S}*${D}*`)
const ENDING_IN = re(String.raw`${B}ENDING${S}+IN${B}${S}*${D}*`)

const PHONE = re(
  String.raw`(?<!${D})(?:\+?1[${SPACE_CHARS}.\-])?\(?${D}{3}\)?[${SPACE_CHARS}.\-]${D}{3}[${SPACE_CHARS}.\-]${D}{4}(?!${D})`,
)
const SHORT_PHONE = re(String.raw`(?<!${D})${D}{3}-${D}{4}(?!${D})`)
const DATE = re(
  String.raw`(?<!${D})${D}{4}-${D}{1,2}-${D}{1,2}(?!${D})` +
    String.raw`|(?<!${D})${D}{1,2}[\/\-]${D}{1,2}(?:[\/\-]${D}{2,4})?(?!${D})`,
)
const DIGIT_GROUPS = re(String.raw`(?<!${D})${D}+(?:[${SPACE_CHARS}\-]+${D}+)+(?!${D})`)
const LONG_DIGITS = re(String.raw`${D}{4,}`)
const EDGE_PUNCTUATION = re(
  String.raw`^[${SPACE_CHARS}\-*#.,\/:;|]+|[${SPACE_CHARS}\-*#.,\/:;|]+$`,
)

const DIGIT = re(D)
const SPACE_RUN = new RegExp(`${S}+`, 'u')
const EDGE_SPACE = re(`^${S}+|${S}+$`)

/** Split on whitespace runs, dropping empty parts. */
function pySplit(text: string): string[] {
  return text.split(SPACE_RUN).filter((part) => part !== '')
}

/** Strip whitespace from both ends. */
function pyStrip(text: string): string {
  return text.replace(EDGE_SPACE, '')
}

/** Length in code points. */
function pyLen(text: string): number {
  return Array.from(text).length
}

/** Escape regex syntax, limited to what a `u`-flag pattern accepts outside a class. */
function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
}

/** Remove card-number-like digit groups split by spaces or dashes once they hold 4+ digits. */
function dropDigitGroups(text: string): string {
  return text.replace(DIGIT_GROUPS, (m) => ((m.match(DIGIT)?.length ?? 0) >= 4 ? ' ' : m))
}

/** Remove owner name tokens as words, then any word that still embeds one. */
function stripOwnerTokens(text: string, ownerNameTokens: Iterable<string>): string {
  const unique = new Set<string>()
  for (const t of ownerNameTokens) {
    if (pyLen(pyStrip(t)) >= 2) unique.add(pyStrip(t).toUpperCase())
  }
  const tokens = [...unique].sort((a, b) => pyLen(b) - pyLen(a))
  if (tokens.length === 0) return text
  const alternatives = tokens.map(escapeRegExp).join('|')
  const stripped = text.replace(re(String.raw`${B}(?:${alternatives})${B}`), ' ')
  const words = pySplit(stripped).filter((w) => !tokens.some((t) => w.includes(t)))
  return words.join(' ')
}

const withGroup = (head: string) => (_m: string, group: string | undefined) =>
  head + (group ? ` ${group}` : '')

/** Normalize a raw bank description into a scrubbed, cacheable merchant key. */
export function merchantKey(rawDescription: string, ownerNameTokens: Iterable<string> = []): string {
  let text = pySplit(rawDescription.toUpperCase()).join(' ')

  text = text.replace(PROCESSOR_PREFIX, '')
  text = text.replace(WIRE, withGroup('WIRE'))
  text = text.replace(CASH_APP, withGroup('CASH APP'))
  text = text.replace(APPLE_CASH, withGroup('APPLE CASH'))
  text = text.replace(PAYPAL_INSTANT, 'PAYPAL $1')
  text = text.replace(BANK_TRANSFER, '$1 $2')
  text = text.replace(ZELLE, 'ZELLE $1')
  text = text.replace(VENMO, withGroup('VENMO'))
  text = text.replace(TRAILING_REFERENCE, ' ')
  text = text.replace(PROCESSOR_PREFIX, '')
  text = text.replace(STAR_REFERENCE, ' ')
  text = text.replace(NUMBER_SIGN, ' ')
  text = text.replace(MASKED_ACCOUNT, ' ')
  text = text.replace(ENDING_IN, ' ENDING IN ')
  text = text.replace(PHONE, ' ')
  text = text.replace(DATE, ' ')
  text = text.replace(SHORT_PHONE, ' ')
  text = dropDigitGroups(text)
  text = text.replace(LONG_DIGITS, ' ')
  text = text.replaceAll('*', ' ')
  text = stripOwnerTokens(text, ownerNameTokens)

  text = pySplit(text).join(' ')
  text = text.replace(EDGE_PUNCTUATION, '')
  const chars = Array.from(text)
  if (chars.length > MAX_KEY_LENGTH) {
    // text[:MAX_KEY_LENGTH].rsplit(" ", 1)[0]
    const head = chars.slice(0, MAX_KEY_LENGTH).join('')
    const cut = head.lastIndexOf(' ')
    text = cut === -1 ? head : head.slice(0, cut)
  }
  return text || EMPTY_KEY
}

/** Coarse magnitude of a transaction, sign ignored. */
export function amountBucket(amount: Cents): AmountBucket {
  const size = Math.abs(amount)
  if (size < 1000) return '<10'
  if (size < 5000) return '10-50'
  if (size < 20000) return '50-200'
  if (size <= 100000) return '200-1000'
  return '>1000'
}

/** AccountType values are exactly the AccountKind literals. */
export function accountKind(accountType: AccountType): AccountKind {
  return accountType
}

/** The only shape in which a transaction is described to an LLM. */
export function buildMerchantInput(key: string, amount: Cents, accountType: AccountType): MerchantInput {
  return {
    merchant_key: key,
    amount_bucket: amountBucket(amount),
    direction: amount > 0 ? 'inflow' : 'outflow',
    account_kind: accountKind(accountType),
  }
}
