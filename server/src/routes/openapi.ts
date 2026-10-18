/** Route building blocks that spell responses and bodies the way FastAPI documented them. */

import type { z } from '@hono/zod-openapi'

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
