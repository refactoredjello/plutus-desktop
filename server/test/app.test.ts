/**
 * createApp: the parts of app/main.py and app/errors.py that are not routes, plus serving the
 * SPA (web/nginx.conf) and the API guard (plan section 5.9).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoute, z } from '@hono/zod-openapi'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openApiDocument } from '../src/app.js'
import { ConflictError, NotFoundError, NotImplementedYetError } from '../src/lib/errors.js'
import { makeApp, testConfig } from './setup.js'

describe('error handler (register_error_handlers)', () => {
  const { app } = makeApp()
  app.get('/api/test/conflict', () => {
    throw new ConflictError('Rule already exists')
  })
  app.get('/api/test/missing/:id', (c) => {
    throw new NotFoundError(`Goal ${c.req.param('id')} not found`)
  })
  app.get('/api/test/stub', () => {
    throw new NotImplementedYetError()
  })
  app.get('/api/test/crash', () => {
    throw new Error('boom')
  })
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/test/validated',
      request: { query: z.object({ limit: z.coerce.number().int().min(1).max(500) }) },
      responses: { 200: { content: { 'application/json': { schema: z.object({ limit: z.number() }) } }, description: 'ok' } },
    }),
    (c) => c.json({ limit: c.req.valid('query').limit }, 200),
  )

  it('renders a DomainError as problem+json', async () => {
    const res = await app.request('/api/test/conflict')
    expect(res.status).toBe(409)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'Rule already exists',
      instance: '/api/test/conflict',
    })
  })

  it('uses the request path as instance, without the query string', async () => {
    const res = await app.request('/api/test/missing/7?x=1')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ title: 'Not found', detail: 'Goal 7 not found', instance: '/api/test/missing/7' })
  })

  it('renders stubs as 501 problem details', async () => {
    const res = await app.request('/api/test/stub')
    expect(res.status).toBe(501)
    expect(await res.json()).toMatchObject({ status: 501, title: 'Not implemented', detail: 'Not implemented yet' })
  })

  it('answers 500 with a plain body for unexpected errors, like Starlette', async () => {
    const res = await app.request('/api/test/crash')
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('Internal Server Error')
  })

  it('renders validation failures as 422 problem details', async () => {
    const res = await app.request('/api/test/validated?limit=900')
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ type: 'about:blank', title: 'Validation error', status: 422, instance: '/api/test/validated' })
    expect(body.detail).toMatch(/^query\.limit: /)
  })

  it('passes valid input through', async () => {
    const res = await app.request('/api/test/validated?limit=50')
    expect(await res.json()).toEqual({ limit: 50 })
  })

  it('answers unknown API paths with a JSON 404 like FastAPI', async () => {
    const res = await app.request('/api/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ detail: 'Not Found' })
  })
})

describe('request id middleware', () => {
  const { app } = makeApp()
  app.get('/api/test/fail', () => {
    throw new ConflictError('x')
  })

  it('generates a hex id when none is sent', async () => {
    const res = await app.request('/api/nope')
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('echoes the id on error responses too', async () => {
    const res = await app.request('/api/test/fail', { headers: { 'x-request-id': 'r-1' } })
    expect(res.headers.get('x-request-id')).toBe('r-1')
  })
})

describe('SPA static handler (web/nginx.conf)', () => {
  let dist: string

  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), 'plutus-web-'))
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Plutus</title>')
    writeFileSync(join(dist, 'favicon.svg'), '<svg/>')
    mkdirSync(join(dist, 'assets'))
    writeFileSync(join(dist, 'assets', 'app-123.js'), 'console.log(1)')
  })

  afterAll(() => rmSync(dist, { recursive: true, force: true }))

  const app = () => makeApp({ config: testConfig({ webDist: dist }) }).app

  it('serves index.html at /', async () => {
    const res = await app().request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(await res.text()).toContain('<title>Plutus</title>')
  })

  it('serves files from the build', async () => {
    const res = await app().request('/favicon.svg')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<svg/>')
  })

  it('caches hashed assets for a year', async () => {
    const res = await app().request('/assets/app-123.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('falls back to index.html for client routes', async () => {
    const res = await app().request('/goals/3')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>Plutus</title>')
  })

  it('answers 404 for a missing asset instead of index.html', async () => {
    const res = await app().request('/assets/missing.js')
    expect(res.status).toBe(404)
  })

  it('never serves index.html for /api paths', async () => {
    const res = await app().request('/api/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ detail: 'Not Found' })
  })

  it('answers 404 when there is no build', async () => {
    const res = await makeApp().app.request('/')
    expect(res.status).toBe(404)
  })
})

describe('API guard (plan 5.9)', () => {
  let dist: string

  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), 'plutus-web-'))
    writeFileSync(join(dist, 'index.html'), '<!doctype html>')
  })

  afterAll(() => rmSync(dist, { recursive: true, force: true }))

  it('is off by default: /api answers without a cookie and HTML sets none', async () => {
    const { app } = makeApp({ config: testConfig({ webDist: dist }) })
    expect((await app.request('/api/nope')).status).toBe(404)
    expect((await app.request('/')).headers.get('set-cookie')).toBeNull()
  })

  describe('when on', () => {
    const guarded = () =>
      makeApp({ config: testConfig({ webDist: dist, apiGuard: true }), guardToken: 'launch-token' }).app

    it('sets an HttpOnly SameSite=Strict cookie on the HTML response', async () => {
      const cookie = (await guarded().request('/')).headers.get('set-cookie') ?? ''
      expect(cookie).toContain('plutus_guard=launch-token')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Strict')
      expect(cookie).toContain('Path=/')
    })

    it('refuses /api requests without the cookie with a 401 problem', async () => {
      const res = await guarded().request('/api/nope')
      expect(res.status).toBe(401)
      expect(res.headers.get('content-type')).toBe('application/problem+json')
      expect(await res.json()).toMatchObject({ status: 401, title: 'Unauthorized', instance: '/api/nope' })
    })

    it('refuses a stale token from a previous launch', async () => {
      const res = await guarded().request('/api/nope', { headers: { cookie: 'plutus_guard=old' } })
      expect(res.status).toBe(401)
    })

    it('lets /api requests with the cookie through', async () => {
      const res = await guarded().request('/api/nope', { headers: { cookie: 'plutus_guard=launch-token' } })
      expect(res.status).toBe(404)
    })

    it('generates a random token per app when none is given', async () => {
      const a = makeApp({ config: testConfig({ webDist: dist, apiGuard: true }) }).app
      const b = makeApp({ config: testConfig({ webDist: dist, apiGuard: true }) }).app
      const tokenOf = async (app: typeof a) =>
        /plutus_guard=([^;]+)/.exec((await app.request('/')).headers.get('set-cookie') ?? '')?.[1]
      const [ta, tb] = [await tokenOf(a), await tokenOf(b)]
      expect(ta).toMatch(/^[A-Za-z0-9_-]{32,}$/)
      expect(ta).not.toBe(tb)
    })
  })
})

describe('OpenAPI document', () => {
  it('describes the API like FastAPI did', () => {
    const doc = openApiDocument(makeApp().app)
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info).toEqual({ title: 'Plutus API', version: '0.1.0' })
  })

  it('is served at /api/openapi.json', async () => {
    const res = await makeApp().app.request('/api/openapi.json')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { info: unknown }).info).toEqual({ title: 'Plutus API', version: '0.1.0' })
  })
})
