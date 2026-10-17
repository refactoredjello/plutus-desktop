/**
 * Date helpers shared by recurring detection and projection. Ports app/services/schedule.py.
 *
 * `today` and `add_months` live in lib/dates.ts (the one place "today" comes from) and are
 * re-exported here under their schedule.py names, so callers can keep importing them from the
 * schedule module as the Python services do.
 */

import type { Cadence, Recurrence } from '../db/schema.js'
import { type PlainDate, addDays, addMonths, daysInMonth, fromParts, toParts } from '../lib/dates.js'

export { addMonths, today } from '../lib/dates.js'

export const MONTH_END_FROM = 28 // a day of month at or above this counts as "month end"

/**
 * Twice a month, alternating between a low and a high day of month.
 *
 * The pair comes from the anchor: a month-end anchor (day >= 28) pairs with the 15th; a day
 * of 13-15 pairs with month end; any other day d <= 15 pairs with d + 15; a day above 15
 * pairs with d - 15. Days clamp to the month's length. The anchor may be either half.
 */
function semimonthly(anchor: PlainDate, n: number): PlainDate {
  const parts = toParts(anchor)
  const day = parts.day
  let low: number
  let high: number | null
  let isLow: boolean
  if (day >= MONTH_END_FROM) {
    ;[low, high, isLow] = [15, null, false]
  } else if (day > 15) {
    ;[low, high, isLow] = [day - 15, day, false]
  } else if (day >= 13) {
    ;[low, high, isLow] = [day, null, true]
  } else {
    ;[low, high, isLow] = [day, day + 15, true]
  }
  const pos = (isLow ? 0 : 1) + n // 2 * month offset + (0 low, 1 high)
  // divmod(pos, 2): floor division, so a negative n steps backwards.
  const months = Math.floor(pos / 2)
  const half = pos - months * 2
  const first = toParts(addMonths(fromParts(parts.year, parts.month, 1), months))
  const monthLast = daysInMonth(first.year, first.month)
  const target = half === 0 ? low : high !== null ? high : monthLast
  return fromParts(first.year, first.month, Math.min(target, monthLast))
}

/**
 * The n-th occurrence after `anchor` (n=0 is the anchor). Computed from the anchor so
 * month-end clamping never drifts (Jan 31 -> Feb 28 -> Mar 31).
 */
export function nthOccurrence(anchor: PlainDate, cadence: Cadence | Recurrence, n: number): PlainDate {
  if (cadence === 'weekly') return addDays(anchor, 7 * n)
  if (cadence === 'biweekly') return addDays(anchor, 14 * n)
  if (cadence === 'monthly') return addMonths(anchor, n)
  if (cadence === 'yearly') return addMonths(anchor, 12 * n)
  if (cadence === 'semimonthly') return semimonthly(anchor, n)
  throw new RangeError(`Cannot repeat with cadence '${String(cadence)}'`)
}

/** One cadence step after `day`. */
export function nextAfter(day: PlainDate, cadence: Cadence): PlainDate {
  return nthOccurrence(day, cadence, 1)
}

/** Occurrence dates d with after < d <= upto. A non-repeating cadence yields the anchor once. */
export function* occurrences(
  anchor: PlainDate,
  cadence: Cadence | Recurrence,
  after: PlainDate,
  upto: PlainDate,
): Generator<PlainDate, void, undefined> {
  if (cadence === 'none') {
    if (after < anchor && anchor <= upto) yield anchor
    return
  }
  for (let n = 0; ; n += 1) {
    const d = nthOccurrence(anchor, cadence, n)
    if (d > upto) return
    if (d > after) yield d
  }
}
