/** Route building blocks for responses and bodies, so every route documents them the same way. */

import type { z } from '@hono/zod-openapi'

/** A JSON success response. */
export function json<T extends z.ZodType>(schema: T) {
  return { content: { 'application/json': { schema } }, description: 'Successful Response' }
}

/** A 204 response. */
export const noContent = { description: 'Successful Response' }

/** A required JSON request body. */
export function jsonBody<T extends z.ZodType>(schema: T) {
  return { content: { 'application/json': { schema } }, required: true }
}
