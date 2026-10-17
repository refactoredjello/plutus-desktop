/** Ports app/routers/projection.py (stub). */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { params } from '../schemas/model.js'
import { queryInt } from '../schemas/params.js'
import { ProjectionRead } from '../schemas/projection.js'
import { json, notImplemented } from './openapi.js'

const getProjection = createRoute({
  method: 'get',
  path: '/api/projection',
  operationId: 'get_projection',
  summary: 'Get Projection',
  tags: ['projection'],
  request: { query: params({ months: queryInt(3, { minimum: 1, maximum: 12 }) }) },
  responses: { 200: json(ProjectionRead) },
})

export function registerProjection(app: App): void {
  app.openapi(getProjection, notImplemented)
}
