/**
 * App factory. Ports app/main.py: error handlers, the request id middleware, and route
 * registration, plus serving the SPA (web/nginx.conf) and the API guard (plan section 5.9).
 * Route registration is pre-wired here so feature briefs never edit it.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import type { Config } from './config.js'
import type { Db } from './db/index.js'
import {
  DomainError,
  PROBLEM_CONTENT_TYPE,
  type Problem,
  ValidationError,
  problemBody,
  validationError,
} from './lib/errors.js'
import { type Logger, createLogger } from './lib/log.js'
import { registerAccounts } from './routes/accounts.js'
import { registerCategories } from './routes/categories.js'
import { registerChanges } from './routes/changes.js'
import { registerGoals } from './routes/goals.js'
import { registerHealth } from './routes/health.js'
import { registerManualEntries } from './routes/manual_entries.js'
import { registerProjection } from './routes/projection.js'
import { registerRecurring } from './routes/recurring.js'
import { registerReports } from './routes/reports.js'
import { registerSettings } from './routes/settings.js'
import { registerSync } from './routes/sync.js'
import { registerTransactions } from './routes/transactions.js'
import type { SecretStore } from './secrets.js'

export const API_PREFIX = '/api'
export const OPENAPI_CONFIG = {
  openapi: '3.1.0',
  info: { title: 'Plutus API', version: '0.1.0' },
} as const

export const GUARD_COOKIE = 'plutus_guard'

export interface AppDeps {
  db: Db
  secrets: SecretStore
  config: Config
  log?: Logger
  /** The per-launch token for the API guard; random when the guard is on and none is given. */
  guardToken?: string
  /** The periodic sync, for GET /api/sync/schedule; none when it is not running here. */
  scheduler?: { nextRunAt(): string | null }
}

export interface AppEnv {
  Variables: {
    db: Db
    secrets: SecretStore
    config: Config
    log: Logger
    requestId: string
    scheduler: { nextRunAt(): string | null } | null
  }
}

export type App = OpenAPIHono<AppEnv>

/** FastAPI's names for the request parts, used as the first element of an issue location. */
const LOCATIONS: Record<string, string> = {
  json: 'body',
  form: 'body',
  query: 'query',
  param: 'path',
  header: 'header',
  cookie: 'cookie',
}

const isApi = (path: string) => path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)

function problem(c: Context, body: Problem): Response {
  return c.body(JSON.stringify(body), body.status as 400, { 'Content-Type': PROBLEM_CONTENT_TYPE })
}

/**
 * The body checks that run before a route's validation hook: @hono/zod-openapi's media type
 * gate (415, missing or wrong Content-Type) and Hono's json validator (400, malformed or empty
 * JSON). FastAPI answered 422 for both; plan 5.5 makes them 422 problem+json.
 */
function isBodyValidationException(err: unknown): err is HTTPException {
  if (!(err instanceof HTTPException)) return false
  return (
    (err.status === 415 && err.message === 'Unsupported Media Type') ||
    (err.status === 400 && err.message === 'Malformed JSON in request body')
  )
}

function requestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const rid = c.req.header('x-request-id') || randomUUID().replaceAll('-', '')
    c.set('requestId', rid)
    c.set('log', c.var.log.child({ request_id: rid }))
    await next()
    c.res.headers.set('x-request-id', rid)
  }
}

function sameToken(a: string | undefined, b: string): boolean {
  if (a === undefined) return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Every /api request must carry the cookie set on the HTML response. */
function apiGuard(token: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isApi(c.req.path) && !sameToken(getCookie(c, GUARD_COOKIE), token)) {
      return problem(c, {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Missing or stale launch token; reload the app.',
        instance: c.req.path,
      })
    }
    await next()
  }
}

/**
 * A required JSON body sent with no Content-Type and no bytes: Hono's json validator hands the
 * route {} (all-optional PATCHes became no-ops), where FastAPI answered 422 at `body`. The
 * routes come from the OpenAPI document, read on first use once every route is registered.
 */
function requiredBody(app: App): MiddlewareHandler<AppEnv> {
  let routes: { method: string; path: RegExp }[] | null = null
  return async (c, next) => {
    if (!['POST', 'PUT', 'PATCH'].includes(c.req.method) || c.req.header('content-type') !== undefined) {
      return next()
    }
    routes ??= Object.entries(openApiDocument(app).paths ?? {}).flatMap(([path, item]) =>
      (['post', 'put', 'patch'] as const)
        .filter((m) => item?.[m]?.requestBody && 'required' in item[m].requestBody && item[m].requestBody.required)
        .map((m) => ({ method: m.toUpperCase(), path: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`) })),
    )
    const route = routes.find((r) => r.method === c.req.method && r.path.test(c.req.path))
    if (route && (await c.req.arrayBuffer()).byteLength === 0) {
      return problem(c, problemBody(new ValidationError('body: Field required'), c.req.path))
    }
    return next()
  }
}

/** The SPA's own files only; style-src allows the inline <style> the chart component writes. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** web/dist with an index.html fallback for client routes, like web/nginx.conf. */
function spa(webDist: string, guardToken: string | null): MiddlewareHandler<AppEnv> {
  // Built on first use: the web build may appear after the server starts (npm run dev).
  let handlers: { files: MiddlewareHandler<AppEnv>; index: MiddlewareHandler<AppEnv> } | null = null
  const noop = async () => {}
  return async (c, next) => {
    if (isApi(c.req.path) || !existsSync(webDist)) return next()
    handlers ??= {
      files: serveStatic<AppEnv>({ root: webDist }),
      index: serveStatic<AppEnv>({ path: join(webDist, 'index.html') }),
    }
    const { files, index } = handlers
    const isIndex = c.req.path === '/' || c.req.path === '/index.html'
    if (!isIndex) {
      const found = await files(c, noop)
      const isAsset = c.req.path.startsWith('/assets/')
      if (found && isAsset) found.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      if (found) return found
      if (isAsset) return next()
    }
    const html = await index(c, noop)
    if (!html) return next()
    html.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    if (guardToken !== null) {
      html.headers.append('Set-Cookie', `${GUARD_COOKIE}=${guardToken}; Path=/; HttpOnly; SameSite=Strict`)
    }
    return html
  }
}

export function openApiDocument(app: App) {
  return app.getOpenAPI31Document(OPENAPI_CONFIG)
}

export function createApp(deps: AppDeps): App {
  const { db, secrets, config } = deps
  const log = deps.log ?? createLogger({ level: config.logLevel })
  const guardToken = config.apiGuard
    ? (deps.guardToken ?? randomBytes(32).toString('base64url'))
    : null

  const app: App = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        throw validationError(result.error.issues, LOCATIONS[result.target] ?? result.target)
      }
    },
  })

  app.use('*', async (c, next) => {
    c.set('db', db)
    c.set('secrets', secrets)
    c.set('config', config)
    c.set('log', log)
    c.set('scheduler', deps.scheduler ?? null)
    await next()
  })
  app.use('*', requestId())
  if (guardToken !== null) app.use('*', apiGuard(guardToken))
  app.use('*', requiredBody(app))

  app.onError((err, c) => {
    if (err instanceof DomainError) return problem(c, problemBody(err, c.req.path))
    if (isBodyValidationException(err)) {
      return problem(c, problemBody(new ValidationError(`body: ${err.message}`), c.req.path))
    }
    if (err instanceof HTTPException) return err.getResponse()
    c.var.log.error({ err }, 'unhandled error')
    return c.text('Internal Server Error', 500)
  })

  app.notFound((c) => {
    if (isApi(c.req.path)) return c.json({ detail: 'Not Found' }, 404)
    return c.text('Not Found', 404)
  })

  // Routes, in app/main.py's ROUTERS order. Brief 0B adds one line per router here.
  registerHealth(app)
  registerAccounts(app)
  registerSync(app)
  registerSettings(app)
  registerTransactions(app)
  registerCategories(app)
  registerChanges(app)
  registerReports(app)
  registerProjection(app)
  registerRecurring(app)
  registerManualEntries(app)
  registerGoals(app)

  app.doc31(`${API_PREFIX}/openapi.json`, OPENAPI_CONFIG)

  app.get('*', spa(config.webDist, guardToken))

  return app
}
