import { describe, expect, it } from 'vitest'
import type { Envelope } from './diff.ts'
import { compareGet, runStep } from './harness.ts'
import type { Json } from './normalize.ts'
import { type Api, PrepareError, type State, type WriteStep } from './writes.ts'

const json = (body: Json, status = 200): Envelope => ({ status, contentType: 'application/json', body })

function fake(routes: Record<string, Envelope>): Api & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async send(method, path) {
      calls.push(`${method} ${path}`)
      return routes[`${method} ${path}`] ?? json({ status: 501 }, 501)
    },
  }
}

describe('compareGet', () => {
  it('names the case by template and finds no difference in equal responses', async () => {
    const body = [{ category_id: 1, total: '5.00', created_at: '2026-10-17T22:28:21.611088Z' }]
    const tsBody = [{ category_id: 1, total: '5.00', created_at: '2026-10-17T22:29:01.002Z' }]
    const result = await compareGet(
      fake({ 'GET /api/reports/by-category?month=2026-09': json(body) }),
      fake({ 'GET /api/reports/by-category?month=2026-09': json(tsBody) }),
      '/api/reports/by-category?month=2026-09',
      'initial',
    )
    expect(result).toEqual({
      endpoint: 'GET /api/reports/by-category',
      label: 'initial',
      request: 'GET /api/reports/by-category?month=2026-09',
      differences: [],
    })
  })

  it('applies the endpoint tie rule', async () => {
    const a = [
      { category_id: 3, total: '5.00' },
      { category_id: 1, total: '5.00' },
    ]
    const b = [a[1]!, a[0]!]
    const path = '/api/reports/by-category?month=2026-09'
    const result = await compareGet(fake({ [`GET ${path}`]: json(a) }), fake({ [`GET ${path}`]: json(b) }), path, 'initial')
    expect(result.differences).toEqual([])
  })

  it('reports a stub answering 501', async () => {
    const result = await compareGet(
      fake({ 'GET /api/accounts': json([]) }),
      fake({}),
      '/api/accounts',
      'initial',
    )
    expect(result.differences[0]).toEqual({ path: '/status', expected: 200, actual: 501 })
  })
})

const step: WriteStep = {
  name: 'create a goal',
  endpoint: 'POST /api/goals',
  async prepare(api) {
    const res = await api.send('GET', '/api/categories')
    if (res.status !== 200) throw new PrepareError('GET /api/categories answered 501')
    return { method: 'POST', path: '/api/goals', body: { name: 'x', pick: (res.body as Json[]).length } }
  },
  capture(res, state) {
    state.goalId = (res.body as { id: number }).id
  },
  reread: (state) => ['/api/goals', `/api/goals/${state.goalId}`],
}

describe('runStep', () => {
  const pythonRoutes = {
    'GET /api/categories': json([1, 2]),
    'POST /api/goals': json({ id: 4 }, 201),
    'GET /api/goals': json([{ id: 4 }]),
    'GET /api/goals/4': json({ id: 4 }),
  }

  it('compares the write and every re-read, capturing state on both sides', async () => {
    const py = { api: fake(pythonRoutes), state: {} as State }
    const ts = { api: fake(pythonRoutes), state: {} as State }
    const results = await runStep(step, 7, py, ts, '2026-09-30')
    expect(results.map((r) => [r.endpoint, r.label, r.request, r.differences.length])).toEqual([
      ['POST /api/goals', 'step 7: create a goal', 'POST /api/goals', 0],
      ['GET /api/goals', 'after step 7: create a goal', 'GET /api/goals', 0],
      ['GET /api/goals/{goal_id}', 'after step 7: create a goal', 'GET /api/goals/4', 0],
    ])
    expect(py.state.goalId).toBe(4)
    expect(ts.state.goalId).toBe(4)
  })

  it('reports a failed preparation on the right-hand app and still runs the Python write', async () => {
    const py = { api: fake(pythonRoutes), state: {} as State }
    const ts = { api: fake({}), state: {} as State }
    const results = await runStep(step, 1, py, ts, '2026-09-30')
    expect(results[0]?.differences).toEqual([
      {
        path: '(prepare)',
        expected: { method: 'POST', path: '/api/goals', body: { name: 'x', pick: 2 } },
        actual: 'failed: GET /api/categories answered 501',
        note: 'could not prepare the step',
      },
    ])
    expect(py.api.calls).toContain('POST /api/goals')
    expect(ts.api.calls).not.toContain('POST /api/goals')
    // The re-reads still run on both; the right-hand app has no captured goal.
    expect(results.slice(1).map((r) => r.request)).toEqual([
      'GET /api/goals',
      'GET /api/goals/4 (other app: /api/goals/undefined)',
    ])
    expect(results[2]?.differences[0]).toEqual({
      path: '(request)',
      expected: '/api/goals/4',
      actual: '/api/goals/undefined',
      note: 'the re-read path differs',
    })
  })

  it('reports when the two apps pick different targets', async () => {
    const py = { api: fake(pythonRoutes), state: {} as State }
    const ts = { api: fake({ ...pythonRoutes, 'GET /api/categories': json([1]) }), state: {} as State }
    const results = await runStep(step, 1, py, ts, '2026-09-30')
    expect(results[0]?.differences[0]).toEqual({
      path: '(request)',
      expected: { method: 'POST', path: '/api/goals', body: { name: 'x', pick: 2 } },
      actual: { method: 'POST', path: '/api/goals', body: { name: 'x', pick: 1 } },
      note: 'the step picked different targets',
    })
  })

  it('reports a Python preparation failure and sends neither write', async () => {
    const py = { api: fake({}), state: {} as State }
    const ts = { api: fake(pythonRoutes), state: {} as State }
    const results = await runStep(step, 1, py, ts, '2026-09-30')
    expect(results[0]?.differences[0]?.note).toBe('Python could not prepare the step')
    expect(ts.api.calls).not.toContain('POST /api/goals')
  })
})
