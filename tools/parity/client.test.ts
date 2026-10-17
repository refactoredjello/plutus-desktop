import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeApi, toEnvelope } from './client.ts'

describe('toEnvelope', () => {
  it('parses JSON and problem+json bodies and strips media type parameters', () => {
    expect(toEnvelope(200, 'application/json; charset=utf-8', '{"a":1}')).toEqual({
      status: 200,
      contentType: 'application/json',
      body: { a: 1 },
    })
    expect(toEnvelope(404, 'application/problem+json', '{"status":404}')).toEqual({
      status: 404,
      contentType: 'application/problem+json',
      body: { status: 404 },
    })
  })

  it('keeps an empty body as null and other bodies as text', () => {
    expect(toEnvelope(204, null, '')).toEqual({ status: 204, contentType: null, body: null })
    expect(toEnvelope(500, 'text/plain', 'Internal Server Error')).toEqual({
      status: 500,
      contentType: 'text/plain',
      body: 'Internal Server Error',
    })
  })

  it('keeps malformed JSON as text so the difference is visible', () => {
    expect(toEnvelope(200, 'application/json', '{nope')).toEqual({
      status: 200,
      contentType: 'application/json',
      body: '{nope',
    })
  })
})

describe('makeApi', () => {
  const seen: { method?: string; url?: string; body: string; type?: string }[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, type: req.headers['content-type'] })
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end('{"id":7}')
    })
  })
  let base = ''

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('sends JSON bodies and returns an envelope', async () => {
    const api = makeApi(base)
    expect(await api.send('POST', '/api/goals', { name: 'x' })).toEqual({
      status: 201,
      contentType: 'application/json',
      body: { id: 7 },
    })
    expect(seen.at(-1)).toEqual({ method: 'POST', url: '/api/goals', body: '{"name":"x"}', type: 'application/json' })
  })

  it('turns a connection failure into status 0 with the reason as the body', async () => {
    const api = makeApi('http://127.0.0.1:1')
    const res = await api.send('GET', '/api/health')
    expect(res.status).toBe(0)
    expect(res.contentType).toBeNull()
    expect(String(res.body)).toMatch(/^request failed: /)
  })
})
