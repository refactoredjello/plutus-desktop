/**
 * Money as integer cents. The only place cents and strings convert.
 *
 * Money is a branded integer number of cents and goes over the wire as "123.45" strings;
 * arithmetic is integer arithmetic, and every division rounds half to even.
 */

declare const centsBrand: unique symbol
export type Cents = number & { readonly [centsBrand]: true }

export const ZERO = 0 as Cents

/** Brand a number as cents. Refuses anything that is not a safe integer. */
export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Not an integer number of cents: ${value}`)
  }
  // Normalise -0 so it never leaks into formatting or equality checks.
  return (value === 0 ? 0 : value) as Cents
}

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/

/**
 * Parse a decimal string ("123.45", "-15.49", "12", ".5") into cents.
 *
 * More than two decimal places round half away from zero (stored amounts' rule).
 */
export function parseMoney(text: string): Cents {
  const match = DECIMAL.exec(text.trim())
  if (!match) throw new RangeError(`Not a money amount: ${JSON.stringify(text)}`)
  const [, sign = '', whole = '', frac = ''] = match
  if (whole === '' && frac === '') throw new RangeError(`Not a money amount: ${JSON.stringify(text)}`)
  const kept = frac.slice(0, 2).padEnd(2, '0')
  const rest = frac.slice(2)
  let value = Number(whole || '0') * 100 + Number(kept)
  if (rest !== '' && rest.charCodeAt(0) >= 53 /* '5' */) value += 1
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Money amount out of range: ${JSON.stringify(text)}`)
  }
  return cents(sign === '-' ? -value : value)
}

/** Format cents as the wire string: two decimals, leading "-" when negative. */
export function formatMoney(value: Cents): string {
  const abs = Math.abs(value)
  const whole = Math.trunc(abs / 100)
  const frac = abs - whole * 100
  return `${value < 0 ? '-' : ''}${whole}.${String(frac).padStart(2, '0')}`
}

function assertDivisor(divisor: number): void {
  if (!Number.isSafeInteger(divisor) || divisor === 0) {
    throw new RangeError(`Divisor must be a non-zero integer: ${divisor}`)
  }
}

/** Integer quotient of a / b rounded half to even. Both are safe integers, b non-zero. */
function roundedQuotient(a: number, b: number): number {
  let q = Math.trunc(a / b)
  let r = a - q * b
  // Float division can land one off for large operands; correct so that |r| < |b| and r has
  // the sign of a (truncated division).
  while (r !== 0 && Math.sign(r) !== Math.sign(a)) {
    q -= Math.sign(a) * Math.sign(b)
    r = a - q * b
  }
  while (Math.abs(r) >= Math.abs(b)) {
    q += Math.sign(a) * Math.sign(b)
    r = a - q * b
  }
  const twice = Math.abs(r) * 2
  const absB = Math.abs(b)
  if (twice > absB || (twice === absB && Math.abs(q) % 2 === 1)) {
    q += Math.sign(a) * Math.sign(b)
  }
  return q === 0 ? 0 : q
}

/** `value / divisor` to the cent, ties to even. */
export function divHalfEven(value: Cents, divisor: number): Cents {
  assertDivisor(divisor)
  return cents(roundedQuotient(value, divisor))
}

/** `value * numerator / denominator` to the cent, ties to even. */
export function mulRatioHalfEven(value: Cents, numerator: number, denominator: number): Cents {
  assertDivisor(denominator)
  if (!Number.isSafeInteger(numerator)) {
    throw new RangeError(`Numerator must be an integer: ${numerator}`)
  }
  const product = value * numerator
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(`Money product out of range: ${value} * ${numerator}`)
  }
  return cents(roundedQuotient(product, denominator))
}

/**
 * The median to the cent: the middle value of an odd list, the mean of the two middle values
 * of an even list rounded half to even. Empty lists throw.
 */
export function median(values: readonly Cents[]): Cents {
  if (values.length === 0) throw new RangeError('no median for empty data')
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as Cents
  return divHalfEven(cents((sorted[mid - 1] as Cents) + (sorted[mid] as Cents)), 2)
}

export function sum(values: readonly Cents[]): Cents {
  let total = 0
  for (const v of values) total += v
  return cents(total)
}
