/**
 * Plain calendar dates as branded "YYYY-MM-DD" strings (plan section 5.3).
 *
 * Python uses `datetime.date`; here a date is a string, so comparisons are string comparisons
 * and the database stores TEXT. Day arithmetic goes through a day number (days since
 * 1970-01-01, proleptic Gregorian), never through a JavaScript Date, so time zones and DST
 * cannot shift a date.
 */

declare const plainDateBrand: unique symbol
export type PlainDate = string & { readonly [plainDateBrand]: true }

/** "YYYY-MM", the month key used by reports. */
export type MonthKey = string

const PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** calendar.monthrange(year, month)[1]: the number of days in a month (month is 1-12). */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

export function isPlainDate(text: string): text is PlainDate {
  const m = PATTERN.exec(text)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}

/** Validate and brand a "YYYY-MM-DD" string. */
export function plainDate(text: string): PlainDate {
  if (!isPlainDate(text)) throw new RangeError(`Not a valid date: ${JSON.stringify(text)}`)
  return text
}

export function fromParts(year: number, month: number, day: number): PlainDate {
  const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return plainDate(text)
}

export function toParts(day: PlainDate): { year: number; month: number; day: number } {
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)), day: Number(day.slice(8, 10)) }
}

// Howard Hinnant's days_from_civil and civil_from_days.
function toDayNumber(value: PlainDate): number {
  const { year, month, day } = toParts(value)
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const mp = (month + 9) % 12
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

function fromDayNumber(n: number): PlainDate {
  const z = n + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0)
  return fromParts(year, month, day)
}

/**
 * The one place "today" comes from: PLUTUS_TODAY when set, else the UTC date. Mirrors
 * services/schedule.today() in Python, which tests and the parity harness pin.
 */
export function today(): PlainDate {
  const pinned = process.env.PLUTUS_TODAY
  if (pinned) return plainDate(pinned)
  return plainDate(new Date().toISOString().slice(0, 10))
}

/** The current instant as an ISO 8601 UTC timestamp, the format stored for timestamps. */
export function utcNow(): string {
  return new Date().toISOString()
}

function epochMillis(seconds: number): number {
  if (!Number.isFinite(seconds)) throw new RangeError(`Not a Unix timestamp: ${seconds}`)
  return seconds * 1000
}

/** `datetime.fromtimestamp(seconds, UTC).date()`. */
export function epochToUtcDate(seconds: number): PlainDate {
  return plainDate(new Date(epochMillis(seconds)).toISOString().slice(0, 10))
}

/** `datetime.fromtimestamp(seconds, UTC)` as an ISO 8601 UTC timestamp. */
export function epochToTimestamp(seconds: number): string {
  return new Date(epochMillis(seconds)).toISOString()
}

/** `day + timedelta(days=n)`. */
export function addDays(day: PlainDate, n: number): PlainDate {
  return fromDayNumber(toDayNumber(day) + n)
}

/** Whole days from a to b: `(b - a).days`. */
export function daysBetween(a: PlainDate, b: PlainDate): number {
  return toDayNumber(b) - toDayNumber(a)
}

export function compareDates(a: PlainDate, b: PlainDate): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** schedule.add_months: shifted by whole months, clamped to the end of the target month. */
export function addMonths(day: PlainDate, months: number): PlainDate {
  const parts = toParts(day)
  const index = parts.year * 12 + (parts.month - 1) + months
  const year = Math.floor(index / 12)
  const month = index - year * 12 + 1
  return fromParts(year, month, Math.min(parts.day, daysInMonth(year, month)))
}

/** aggregates.month_key: "YYYY-MM". */
export function monthKey(day: PlainDate): MonthKey {
  return day.slice(0, 7)
}

/** aggregates.month_bounds: first day of `month` and first day of the following month. */
export function monthBounds(month: MonthKey): [PlainDate, PlainDate] {
  const year = Number(month.slice(0, 4))
  const mon = Number(month.slice(5, 7))
  const start = fromParts(year, mon, 1)
  const next = mon === 12 ? fromParts(year + 1, 1, 1) : fromParts(year, mon + 1, 1)
  return [start, next]
}
