/**
 * Typed API client generated from the FastAPI OpenAPI spec.
 * Never hand-write fetch calls; regenerate types with `npm run gen:api`.
 */
import createClient from 'openapi-fetch'
import type { components, paths } from './schema'

export const api = createClient<paths>({
  // Same origin as the page: Vite proxies /api in development, nginx in production.
  baseUrl: globalThis.location.origin,
  credentials: 'include',
  // Resolve fetch per call so test mocks installed after import still apply.
  fetch: (request) => globalThis.fetch(request),
})

export type Schemas = components['schemas']

/** RFC 9457 problem details returned by the API on errors. */
export interface Problem {
  title: string
  status: number
  detail: string
}

export class ApiError extends Error {
  readonly status: number

  constructor(problem: Partial<Problem> | undefined, fallbackStatus: number) {
    super(problem?.detail ?? problem?.title ?? 'Request failed')
    this.status = problem?.status ?? fallbackStatus
  }
}

/** Unwrap an openapi-fetch result for TanStack Query: return data or throw ApiError. */
export async function unwrap<T>(
  promise: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await promise
  if (error !== undefined || !response.ok) {
    throw new ApiError(error as Partial<Problem> | undefined, response.status)
  }
  return data as T
}
