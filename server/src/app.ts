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
  problemBody,
  validationError,
} from './lib/errors.js'
import { type Logger, createLogger } from './lib/log.js'
import { registerHealth } from './routes/health.js'
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
}

export interface AppEnv {
  Variables: {
    db: Db
    secrets: SecretStore
    config: Config
    log: Logger
    requestId: string
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
    await next()
  })
  app.use('*', requestId())
  if (guardToken !== null) app.use('*', apiGuard(guardToken))

  app.onError((err, c) => {
    if (err instanceof DomainError) return problem(c, problemBody(err, c.req.path))
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

  app.doc31(`${API_PREFIX}/openapi.json`, OPENAPI_CONFIG)

  app.get('*', spa(config.webDist, guardToken))

  return app
}
