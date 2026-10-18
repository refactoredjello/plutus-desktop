/**
 * GET /api/accounts: an empty list, the account fields after a sync (rows inserted directly),
 * the ordering, and the latest-snapshot rule.
 */

import { eq } from 'drizzle-orm'
import { expect, it } from 'vitest'
import type { Db } from '../src/db/index.js'
import { accounts, balanceSnapshots } from '../src/db/schema.js'
import { parseMoney } from '../src/lib/money.js'
import { makeAccount } from './factories.js'
import { makeApp } from './setup.js'

function snapshot(db: Db, accountId: number, balance: string, asOf: string, available: string | null = null): void {
  db.insert(balanceSnapshots)
    .values({
      account_id: accountId,
      balance: parseMoney(balance),
      available: available === null ? null : parseMoney(available),
      as_of: asOf,
    })
    .run()
}

async function list(app: ReturnType<typeof makeApp>['app']): Promise<any[]> {
  const r = await app.request('/api/accounts')
  expect(r.status).toBe(200)
  return (await r.json()) as any[]
}

it('accounts empty', async () => {
  const { app } = makeApp()
  expect(await list(app)).toEqual([])
})

it('shows each account with its latest snapshot (the fields a sync fills)', async () => {
  const { app, db } = makeApp()
  const visa = makeAccount(db, 'credit', 'Rewards Visa')
  snapshot(db, visa.id, '-800.00', '2026-03-01T12:00:00.000Z', '7200.00')
  snapshot(db, visa.id, '-842.17', '2026-03-02T12:00:00.000Z', '7157.83')
  const body = await list(app)
  expect(body).toEqual([
    {
      id: visa.id,
      name: 'Rewards Visa',
      type: 'credit',
      institution_name: null,
      currency: 'USD',
      is_active: true,
      balance: '-842.17',
      available: '7157.83',
      balance_as_of: '2026-03-02T12:00:00.000Z',
    },
  ])
})

it('an account without snapshots has null balance fields; inactive accounts are listed', async () => {
  const { app, db } = makeApp()
  const closed = makeAccount(db, 'savings', 'Closed')
  db.update(accounts).set({ is_active: false }).where(eq(accounts.id, closed.id)).run()
  snapshot(db, closed.id, '5.00', '2026-03-01T00:00:00.000Z')
  const bare = makeAccount(db, 'checking', 'Bare')
  const body = await list(app)
  expect(body.map((a) => [a.name, a.is_active, a.balance, a.available, a.balance_as_of])).toEqual([
    ['Bare', true, null, null, null],
    ['Closed', false, '5.00', null, '2026-03-01T00:00:00.000Z'],
  ])
  expect(body[0].id).toBe(bare.id)
})

it('a same-instant tie picks the later snapshot id', async () => {
  const { app, db } = makeApp()
  const chk = makeAccount(db)
  snapshot(db, chk.id, '1.00', '2026-03-01T00:00:00.000Z')
  snapshot(db, chk.id, '2.00', '2026-03-01T00:00:00.000Z')
  snapshot(db, chk.id, '9.00', '2026-02-28T00:00:00.000Z')
  expect((await list(app)).map((a) => a.balance)).toEqual(['2.00'])
})

it('orders by institution name (no institution last), name, then id', async () => {
  const { app, db } = makeApp()
  const setInstitution = (id: number, name: string) =>
    db.update(accounts).set({ institution_name: name }).where(eq(accounts.id, id)).run()
  const none = makeAccount(db, 'checking', 'Alpha')
  const b2 = makeAccount(db, 'checking', 'Zed')
  setInstitution(b2.id, 'Bank B')
  const b1 = makeAccount(db, 'checking', 'Same')
  setInstitution(b1.id, 'Bank B')
  const b1dup = makeAccount(db, 'checking', 'Same')
  setInstitution(b1dup.id, 'Bank B')
  const a = makeAccount(db, 'checking', 'Zulu')
  setInstitution(a.id, 'Bank A')
  expect((await list(app)).map((x) => x.id)).toEqual([a.id, b1.id, b1dup.id, b2.id, none.id])
})
