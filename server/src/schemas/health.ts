/** Ports app/schemas/health.py. */

import { z } from '@hono/zod-openapi'

export const HealthRead = z
  .object({
    status: z.enum(['ok', 'degraded']),
    database: z.enum(['ok', 'unreachable']),
    version: z.string(),
  })
  .openapi('HealthRead')

export type HealthRead = z.infer<typeof HealthRead>
