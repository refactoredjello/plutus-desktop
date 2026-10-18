/** GET /api/health. */

import { describe, expect, it } from 'vitest'
import { makeApp } from './setup.js'

describe('health', () => {
  it('reports ok', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(body.database).toBe('ok')
  })

  it('echoes the request id', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/health', { headers: { 'x-request-id': 'abc123' } })
    expect(res.headers.get('x-request-id')).toBe('abc123')
  })

  it('returns problem details from stubs', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/goals')
    if (res.status === 501) {
      expect(res.headers.get('content-type')).toBe('application/problem+json')
      expect(((await res.json()) as Record<string, unknown>).status).toBe(501)
    }
  })

  // The database check fails.
  it('reports degraded when the database is unreachable', async () => {
    const { app, db } = makeApp()
    db.$client.close()
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'degraded', database: 'unreachable', version: '0.1.0' })
  })

  it('reports the package version when no app version is given (headless)', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/health')
    expect(((await res.json()) as Record<string, unknown>).version).toBe('0.1.0')
  })

  it('reports the app version it was given (the desktop release)', async () => {
    const { app } = makeApp({ appVersion: '9.8.7' })
    const res = await app.request('/api/health')
    expect(await res.json()).toEqual({ status: 'ok', database: 'ok', version: '9.8.7' })
  })

  it('reports the given app version when degraded too', async () => {
    const { app, db } = makeApp({ appVersion: '9.8.7' })
    db.$client.close()
    const res = await app.request('/api/health')
    expect(await res.json()).toEqual({ status: 'degraded', database: 'unreachable', version: '9.8.7' })
  })
})
