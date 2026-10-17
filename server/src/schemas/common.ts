/**
 * Shared schema building blocks. Ports app/schemas/common.py.
 *
 * Pydantic's `Schema` base (extra="forbid") is `z.strictObject` for request bodies; its
 * `ReadSchema` base (from_attributes) needs no counterpart, as rows are plain objects.
 */

import { z } from '@hono/zod-openapi'

/**
 * Money on the wire: a string with exactly two decimals and a leading "-" when negative, so no
 * float rounding reaches the browser. Convert with lib/money.ts.
 */
export const Money = z.string().regex(/^-?\d+\.\d{2}$/)

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
      items: z.array(item),
      total: z.int(),
      limit: z.int(),
      offset: z.int(),
    })
    .openapi(`Page_${name}_`, { title: `Page[${name}]` })
}
