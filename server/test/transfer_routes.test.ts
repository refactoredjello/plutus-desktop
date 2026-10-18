/**
 * Unpairing a transfer (backlog 36), and which rows a sync pairs: only pairs with a new or
 * newly posted row, so a pair the owner split stays split.
 */

import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Db } from '../src/db/index.js'
import { categories, categorizations, transactions } from '../src/db/schema.js'
import { utcNow } from '../src/lib/dates.js'
import { parseMoney } from '../src/lib/money.js'
import { SimpleFINProvider } from '../src/providers/bank/simplefin.js'
import type { BankProvider, ProviderSnapshot, ProviderTransaction } from '../src/providers/bank/types.js'
import { KeySecretStore } from '../src/secrets.js'
import * as sync from '../src/services/sync.js'
import { ACCESS_URL, type Transaction, categoryId, makeAccount, makeTx, mockFetch } from './factories.js'
import { makeApp } from './setup.js'

type Body = Record<string, unknown>

function reload(db: Db, id: number): Transaction {
  const row = db.select().from(transactions).where(eq(transactions.id, id)).get()
  if (row === undefined) throw new Error(`Transaction ${id} is gone`)
  return row
}

function pair(db: Db, a: Transaction, b: Transaction): void {
  db.update(transactions).set({ is_transfer: true, transfer_pair_id: b.id }).where(eq(transactions.id, a.id)).run()
  db.update(transactions).set({ is_transfer: true, transfer_pair_id: a.id }).where(eq(transactions.id, b.id)).run()
}

function categorize(db: Db, tx: Transaction, detailed: string, source: 'rule' | 'manual' | 'llm', confidence: 'high' | 'very_high') {
  db.insert(categorizations)
    .values({ transaction_id: tx.id, category_id: categoryId(db, detailed), essentiality: null, source, confidence, updated_at: utcNow() })
    .run()
}

function detailedOf(db: Db, tx: Transaction): string | undefined {
  return db
    .select({ detailed: categories.detailed })
    .from(categorizations)
    .innerJoin(categories, eq(categories.id, categorizations.category_id))
    .where(eq(categorizations.transaction_id, tx.id))
    .get()?.detailed
}

function unpair(app: ReturnType<typeof makeApp>['app'], id: number) {
  return app.request(`/api/transactions/${id}/unpair`, { method: 'POST' })
}

describe('POST /api/transactions/{id}/unpair', () => {
  it('clears the pair on both rows and returns the transaction', async () => {
    const { app, db } = makeApp()
    const a = makeAccount(db, 'credit')
    const b = makeAccount(db, 'credit')
    const refund = makeTx(db, a, '45.00', 'AMZN MKTP REFUND', '2026-03-10')
    const charge = makeTx(db, b, '-45.00', 'TARGET OAKLAND', '2026-03-11')
    pair(db, refund, charge)
    const res = await unpair(app, charge.id)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Body
    expect(body).toMatchObject({ id: charge.id, is_transfer: false, amount: '-45.00' })
    for (const tx of [refund, charge]) {
      expect(reload(db, tx.id)).toMatchObject({ is_transfer: false, transfer_pair_id: null })
    }
  })

  it('drops the transfer category the pairing set, and keeps any other', async () => {
    const { app, db } = makeApp()
    const a = makeAccount(db, 'checking')
    const b = makeAccount(db, 'credit')
    const out = makeTx(db, a, '-45.00', 'SOME MERCHANT', '2026-03-10')
    const inc = makeTx(db, b, '45.00', 'SOME REFUND', '2026-03-10')
    pair(db, out, inc)
    categorize(db, out, 'TRANSFER_OUT_ACCOUNT_TRANSFER', 'rule', 'high')
    categorize(db, inc, 'TRANSFER_IN_ACCOUNT_TRANSFER', 'manual', 'very_high')
    expect((await unpair(app, out.id)).status).toBe(200)
    expect(detailedOf(db, out)).toBeUndefined()
    expect(detailedOf(db, inc)).toBe('TRANSFER_IN_ACCOUNT_TRANSFER')
  })

  it('unpairs a transfer whose other row is gone', async () => {
    const { app, db } = makeApp()
    const a = makeAccount(db)
    const tx = makeTx(db, a, '-45.00', 'ONLINE TRANSFER', '2026-03-10', { is_transfer: true })
    expect((await unpair(app, tx.id)).status).toBe(200)
    expect(reload(db, tx.id).is_transfer).toBe(false)
  })

  it('answers 404 for an unknown transaction', async () => {
    const { app } = makeApp()
    const res = await unpair(app, 999)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  it('answers 400 for a transaction that is not paired', async () => {
    const { app, db } = makeApp()
    const tx = makeTx(db, makeAccount(db), '-45.00')
    const res = await unpair(app, tx.id)
    expect(res.status).toBe(400)
    expect(((await res.json()) as Body).detail).toMatch(/not a transfer/)
  })
})

describe('sync and unpaired transfers', () => {
  const secrets = (config: ReturnType<typeof makeApp>['config']) => new KeySecretStore(config.secretKey)

  it('does not pair them again on the next sync', async () => {
    const { app, db, config } = makeApp()
    const provider = new SimpleFINProvider(ACCESS_URL, mockFetch())
    await sync.runSync(db, secrets(config), config.defaults, provider, 'manual')
    const transfer = db.select().from(transactions).where(eq(transactions.is_transfer, true)).get()
    if (transfer?.transfer_pair_id == null) throw new Error('The fixture pairs no transfer')
    const otherId = transfer.transfer_pair_id
    expect((await unpair(app, transfer.id)).status).toBe(200)

    const run = await sync.runSync(db, secrets(config), config.defaults, provider, 'manual')
    expect(run.status).toBe('success')
    expect(reload(db, transfer.id)).toMatchObject({ is_transfer: false, transfer_pair_id: null })
    expect(reload(db, otherId)).toMatchObject({ is_transfer: false, transfer_pair_id: null })
  })

  class Provider implements BankProvider {
    readonly name = 'simplefin'
    constructor(private readonly snapshots: ProviderSnapshot[]) {}
    async fetch(): Promise<ProviderSnapshot> {
      const next = this.snapshots.shift()
      if (next === undefined) throw new Error('No snapshot left')
      return next
    }
  }

  function ptx(ext: string, amount: string, description: string, pending = false): ProviderTransaction {
    return {
      external_id: ext,
      posted_on: '2026-10-01' as ProviderTransaction['posted_on'],
      amount: parseMoney(amount),
      description,
      payee: null,
      memo: null,
      pending,
      transacted_at: null,
    }
  }

  function snap(checking: ProviderTransaction[], savings: ProviderTransaction[]): ProviderSnapshot {
    const account = (external_id: string, name: string, type: 'checking' | 'savings', txs: ProviderTransaction[]) => ({
      external_id,
      name,
      type,
      institution_name: 'Bank',
      currency: 'USD',
      balance: parseMoney('100.00'),
      available: null,
      balance_as_of: '2026-10-03T00:00:00.000Z',
      transactions: txs,
    })
    return { accounts: [account('C1', 'Checking', 'checking', checking), account('S1', 'Savings', 'savings', savings)], errors: [] }
  }

  it('pairs a new row with an older unmatched one, and a row that just posted', async () => {
    const { db, config } = makeApp()
    const out = ptx('c1', '-500.00', 'ONLINE TRANSFER TO SAV')
    const inc = ptx('s1', '500.00', 'ONLINE TRANSFER FROM CHK')
    const pendingOut = ptx('c2', '-90.00', 'ONLINE TRANSFER TO SAV', true)
    const inc2 = ptx('s2', '90.00', 'ONLINE TRANSFER FROM CHK')
    const provider = new Provider([
      snap([out, pendingOut], []),
      snap([out, { ...pendingOut, pending: false }], [inc, inc2]),
    ])
    await sync.runSync(db, secrets(config), config.defaults, provider, 'manual')
    expect(db.select().from(transactions).where(eq(transactions.is_transfer, true)).all()).toHaveLength(0)
    await sync.runSync(db, secrets(config), config.defaults, provider, 'manual')
    const paired = db.select().from(transactions).where(eq(transactions.is_transfer, true)).all()
    expect(paired.map((t) => t.external_id).sort()).toEqual(['c1', 'c2', 's1', 's2'])
  })
})
