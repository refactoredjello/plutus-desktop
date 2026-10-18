/** Request and response schemas for the health check. */

import { z } from '@hono/zod-openapi'

export const HealthRead = z
  .object({
    status: z.enum(['ok', 'degraded']).openapi({ title: 'Status' }),
    database: z.enum(['ok', 'unreachable']).openapi({ title: 'Database' }),
    version: z.string().openapi({ title: 'Version' }),
  })
  .openapi('HealthRead', { title: 'HealthRead' })

export type HealthRead = z.infer<typeof HealthRead>
