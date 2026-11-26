/**
 * The Host check: a request must name this server in its Host header, so a web page that
 * rebinds its own domain to 127.0.0.1 (DNS rebinding) can't reach the API or get the guard
 * cookie set for its origin.
 */

import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { makeApp, testConfig } from './setup.js'

const at = (host: string) => `http://${host}/api/health`

describe('Host check', () => {
  it('allows the loopback names on any port', async () => {
    const { app } = makeApp()
    for (const host of ['127.0.0.1:8000', 'localhost:51234', '[::1]:8000', 'LOCALHOST', '127.0.0.1']) {
      expect((await app.request(at(host))).status, host).toBe(200)
    }
  })

  it('refuses any other Host with a 403 problem, on /api and on the SPA', async () => {
    const { app } = makeApp()
    const res = await app.request(at('evil.example:8000'))
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    expect(await res.json()).toMatchObject({ status: 403, title: 'Forbidden' })
    expect((await app.request('http://evil.example/')).status).toBe(403)
    expect((await app.request('http://127.0.0.2:8000/api/health')).status).toBe(403)
  })

  it('refuses before the guard sets its cookie', async () => {
    const { app } = makeApp({ config: testConfig({ apiGuard: true }), guardToken: 'launch-token' })
    const res = await app.request('http://evil.example/')
    expect(res.status).toBe(403)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('allows the configured HOST when it is a name, not a wildcard', async () => {
    expect((await makeApp({ config: testConfig({ host: 'plutus.lan' }) }).app.request(at('plutus.lan:8000'))).status).toBe(200)
    expect((await makeApp({ config: testConfig({ host: '0.0.0.0' }) }).app.request(at('0.0.0.0:8000'))).status).toBe(403)
  })

  it('allows the names in PLUTUS_ALLOWED_HOSTS, case-insensitively', async () => {
    const config = testConfig({ allowedHosts: ['plutus.example.com'] })
    const { app } = makeApp({ config })
    expect((await app.request(at('Plutus.Example.com'))).status).toBe(200)
    expect((await app.request(at('other.example.com'))).status).toBe(403)
  })

  it('reads PLUTUS_ALLOWED_HOSTS as a comma-separated list', () => {
    expect(loadConfig({}).allowedHosts).toEqual([])
    expect(loadConfig({ PLUTUS_ALLOWED_HOSTS: ' plutus.example.com, Home.Lan ,' }).allowedHosts).toEqual([
      'plutus.example.com',
      'home.lan',
    ])
  })

  it('checks the Host header a real listener receives', async () => {
    const { app } = makeApp()
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const { port } = server.address() as AddressInfo
    const statusFor = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/api/health', headers: { host } }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', reject)
        req.end()
      })
    try {
      expect(await statusFor(`127.0.0.1:${port}`)).toBe(200)
      expect(await statusFor(`evil.example:${port}`)).toBe(403)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
