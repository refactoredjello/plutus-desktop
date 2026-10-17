/** Route building blocks that spell responses and bodies the way FastAPI documented them. */

import type { z } from '@hono/zod-openapi'
import { NotImplementedYetError } from '../lib/errors.js'

/** A JSON success response (`response_model=...`). */
export function json<T extends z.ZodType>(schema: T) {
  return { content: { 'application/json': { schema } }, description: 'Successful Response' }
}

/** A 204 response (`status_code=HTTP_204_NO_CONTENT`). */
export const noContent = { description: 'Successful Response' }

/** A required JSON request body. */
export function jsonBody<T extends z.ZodType>(schema: T) {
  return { content: { 'application/json': { schema } }, required: true }
}

/** The handler of a Wave 0 stub, until the owning brief implements the route. */
export function notImplemented(): never {
  throw new NotImplementedYetError()
}
