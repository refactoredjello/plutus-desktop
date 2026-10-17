/**
 * Path and query parameter types that parse strings the way FastAPI and Pydantic's lax mode
 * did, documented with the types FastAPI documented. Titles come from `params()` in model.ts.
 */

import { z } from '@hono/zod-openapi'

/** Pydantic's lax int from a string: spaces, a sign, digit groups with "_", and ".0" allowed. */
const INT_STRING = /^\s*[+-]?\d(?:_?\d)*(?:\.0*)?\s*$/

function laxInt(value: unknown): unknown {
  return typeof value === 'string' && INT_STRING.test(value) ? Number(value.trim().replaceAll('_', '')) : value
}

/** Pydantic's lax bool from a string, case-insensitive. */
const TRUTHY = ['true', '1', 'yes', 'on', 't', 'y']
const FALSY = ['false', '0', 'no', 'off', 'f', 'n']

interface Bounds {
  minimum?: number
  maximum?: number
}

function boundedInt({ minimum, maximum }: Bounds) {
  let int = z.int()
  if (minimum !== undefined) int = int.min(minimum)
  if (maximum !== undefined) int = int.max(maximum)
  return int
}

/** `name: int` in a path. */
export function pathInt() {
  return z.preprocess(laxInt, z.int()).openapi({ type: 'integer' })
}

/** `name: int = Query(default, ge=..., le=...)`. */
export function queryInt(defaultValue: number, bounds: Bounds = {}) {
  return z
    .preprocess(laxInt, boundedInt(bounds))
    .default(defaultValue)
    .openapi({ type: 'integer', default: defaultValue, ...bounds })
}

/** `name: bool = default`. */
export function queryBool(defaultValue: boolean) {
  return z
    .stringbool({ truthy: TRUTHY, falsy: FALSY })
    .default(defaultValue)
    .openapi({ type: 'boolean', default: defaultValue })
}

/** `name: list[int] | None = Query(None)`: repeat the parameter for more than one value. */
export function queryIntList() {
  return z
    .preprocess((value) => (value === undefined || Array.isArray(value) ? value : [value]), z.array(z.preprocess(laxInt, z.int())))
    .optional()
    .openapi({ type: ['array', 'null'], items: { type: 'integer' } })
}

/** `month: str` matching YYYY-MM, in a path or query. */
export const Month = z.string().regex(/^\d{4}-\d{2}$/)
