/**
 * Shared schema building blocks. Ports app/schemas/common.py.
 *
 * Pydantic's `Schema` base (extra="forbid") is `z.strictObject` for request bodies; its
 * `ReadSchema` base (from_attributes) needs no counterpart, as rows are plain objects.
 */

import { z } from '@hono/zod-openapi'
import { type Cents, parseMoney } from '../lib/money.js'

/**
 * Money on the wire: a string with exactly two decimals and a leading "-" when negative, so no
 * float rounding reaches the browser. Convert with lib/money.ts.
 */
export const Money = z.string().regex(/^-?\d+\.\d{2}$/)

/** FastAPI's documented pattern for a Pydantic Decimal given as a string. */
const DECIMAL_STRING = /^(?!^[-+.]*$)[+-]?0*\d*\.?\d*$/

/** A JSON number as its shortest decimal string; exponent forms ("1e+21", "1e-7") fail. */
function decimalText(value: number | string): string {
  return typeof value === 'number' ? String(value) : value
}

/** Pydantic's `gt=0`, on the decimal as given, before rounding to cents. */
function isPositive(text: string): boolean {
  return !text.startsWith('-') && /[1-9]/.test(text)
}

function toCents(value: number | string, ctx: z.RefinementCtx): Cents {
  const text = decimalText(value)
  if (!DECIMAL_STRING.test(text)) {
    ctx.addIssue({ code: 'custom', message: 'Input should be a valid decimal' })
    return z.NEVER
  }
  try {
    return parseMoney(text)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Input should be a valid decimal' })
    return z.NEVER
  }
}

/**
 * Money in a request body, as Pydantic's Decimal took it: a JSON number or a decimal string
 * ("1000", "15.5", "-15.49"). Parses to cents; more than two places round half away from
 * zero, as NUMERIC(14,2) did when the Python app stored the value. Documented as FastAPI did.
 */
export const MoneyInput = z
  .union([z.number(), z.string().regex(DECIMAL_STRING)])
  .transform(toCents)

/** MoneyInput with `Field(gt=0)`: zero and negative amounts are rejected. */
export const PositiveMoneyInput = z
  .union([
    z.number().gt(0),
    z
      .string()
      .regex(DECIMAL_STRING)
      .refine(isPositive, { message: 'Input should be greater than 0' }),
  ])
  .transform(toCents)

/** A calendar date, "YYYY-MM-DD" (Pydantic `date`, OpenAPI format date). */
export const PlainDate = z.iso.date()

/** A timestamp, ISO 8601 (Pydantic `datetime`, OpenAPI format date-time). */
export const DateTime = z.iso.datetime({ offset: true })

/**
 * `Page[T]`, registered under FastAPI's component name for generic models: Page_<Name>_.
 * `name` is the item schema's component name.
 */
export function Page<T extends z.ZodType>(item: T, name: string) {
  return z
    .object({
      items: z.array(item).openapi({ title: 'Items' }),
      total: z.int().openapi({ title: 'Total' }),
      limit: z.int().openapi({ title: 'Limit' }),
      offset: z.int().openapi({ title: 'Offset' }),
    })
    .openapi(`Page_${name}_`, { title: `Page[${name}]` })
}
