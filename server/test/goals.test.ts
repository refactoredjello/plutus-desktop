/** Ports api/tests/test_goals.py. */

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { balanceSnapshots, goals } from '../src/db/schema.js'
import { plainDate, utcNow } from '../src/lib/dates.js'
import { parseMoney } from '../src/lib/money.js'
import { monthsBetween } from '../src/services/goals.js'
import { makeAccount, makeTx } from './factories.js'
import { makeApp } from './setup.js'

const TODAY = '2026-10-15'

type Body = Record<string, unknown>
type Goal = { id: number; progress: Body; [key: string]: unknown }

let ctx: ReturnType<typeof makeApp>

// frozen_today: schedule.today() is pinned through PLUTUS_TODAY.
beforeEach(() => {
  vi.stubEnv('PLUTUS_TODAY', TODAY)
  ctx = makeApp()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await ctx.app.request(path, init)
  const text = await res.text()
  return { status: res.status, json: text === '' ? null : JSON.parse(text) }
}

function setBalance(accountId: number, balance: string): void {
  ctx.db.insert(balanceSnapshots).values({ account_id: accountId, balance: parseMoney(balance), as_of: utcNow() }).run()
}

describe('months_between', () => {
  it.each([
    ['2026-10-15', '2027-10-15', 12],
    ['2026-10-15', '2027-10-14', 11],
    ['2026-10-31', '2026-11-30', 0],
    ['2026-10-15', '2026-11-15', 1],
    ['2026-10-15', '2026-10-20', 0],
    ['2026-10-15', '2026-10-15', 0],
    ['2026-10-15', '2026-09-01', 0],
    ['2026-12-20', '2027-02-20', 2],
  ])('%s to %s is %i', (start, end, expected) => {
    expect(monthsBetween(plainDate(start), plainDate(end))).toBe(expected)
  })
})

describe('goals', () => {
  it('computes progress by hand', async () => {
    const db = ctx.db
    const acct = makeAccount(db)
    setBalance(acct.id, '10000.00')
    const r = await call('POST', '/api/goals', { name: 'Trip', target_amount: '6000', target_date: '2027-04-15' })
    expect(r.status).toBe(201)
    const goal = r.json as Goal
    expect(goal.starting_amount).toBe('10000.00')

    // Balance grows 1500; last three complete months are Jul, Aug, Sep 2026.
    setBalance(acct.id, '11500.00')
    makeTx(db, acct, '3000', 'PAYROLL', '2026-07-05')
    makeTx(db, acct, '3000', 'PAYROLL', '2026-08-05')
    makeTx(db, acct, '3000', 'PAYROLL', '2026-09-05')
    makeTx(db, acct, '-2400', 'RENT', '2026-07-06')
    makeTx(db, acct, '-2400', 'RENT', '2026-08-06')
    makeTx(db, acct, '-2250', 'RENT', '2026-09-06')
    // Current month is incomplete and must not count.
    makeTx(db, acct, '-5000', 'BIG', '2026-10-02')

    const p = ((await call('GET', `/api/goals/${goal.id}`)).json as Goal).progress
    expect(p).toEqual({
      saved_so_far: '1500.00',
      remaining: '4500.00',
      months_left: 6,
      required_monthly: '750.00',
      actual_monthly_average: '650.00', // (600 + 600 + 750) / 3
      on_track: false,
    })
  })

  it('is on track when the target is overshot', async () => {
    const acct = makeAccount(ctx.db)
    setBalance(acct.id, '0.00')
    const gid = ((await call('POST', '/api/goals', { name: 'G', target_amount: '100', target_date: '2026-10-20' })).json as Goal)
      .id
    setBalance(acct.id, '500.00')
    const p = ((await call('GET', `/api/goals/${gid}`)).json as Goal).progress
    expect(p.remaining).toBe('0.00')
    expect(p.months_left).toBe(0)
    expect(p.required_monthly).toBe('0.00')
    expect(p.on_track).toBe(true)
  })

  it('needs a target date in the future', async () => {
    for (const d of ['2026-10-15', '2020-01-01']) {
      const r = await call('POST', '/api/goals', { name: 'G', target_amount: '10', target_date: d })
      expect(r.status).toBe(400)
    }
  })

  it('lists active first, then by target date', async () => {
    const make = async (name: string, d: string): Promise<number> => {
      const body = { name, target_amount: '10', target_date: d }
      return Number(((await call('POST', '/api/goals', body)).json as Goal).id)
    }
    const late = await make('late', '2028-01-01')
    const early = await make('early', '2027-01-01')
    const done = await make('done', '2026-12-01')
    await call('PATCH', `/api/goals/${done}`, { is_active: false })
    expect(((await call('GET', '/api/goals')).json as Goal[]).map((g) => g.id)).toEqual([early, late, done])
  })

  it('patches a goal', async () => {
    const gid = ((await call('POST', '/api/goals', { name: 'G', target_amount: '10', target_date: '2027-01-01' })).json as Goal)
      .id
    const r = await call('PATCH', `/api/goals/${gid}`, { name: 'Renamed', target_amount: '20' })
    expect((r.json as Goal).name).toBe('Renamed')
    expect((r.json as Goal).target_amount).toBe('20.00')
    expect((r.json as Goal).target_date).toBe('2027-01-01')
    expect((await call('PATCH', `/api/goals/${gid}`, { target_date: '2026-01-01' })).status).toBe(400)
    expect((await call('PATCH', `/api/goals/${gid}`, { name: null })).status).toBe(400)
    expect(ctx.db.select().from(goals).where(eq(goals.id, gid)).get()).toBeDefined()
  })

  it('answers 404 for a missing goal', async () => {
    expect((await call('GET', '/api/goals/999999')).status).toBe(404)
    expect((await call('PATCH', '/api/goals/999999', { name: 'x' })).status).toBe(404)
  })
})
