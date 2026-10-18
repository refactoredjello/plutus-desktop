/** Internal transfer matching. */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/index.js'
import { transactions } from '../src/db/schema.js'
import { daysBetween } from '../src/lib/dates.js'
import { matchTransfers } from '../src/services/transfers.js'
import { type Transaction, loadSimplefinFixture, makeAccount, makeTx } from './factories.js'
import { makeDb } from './setup.js'

let db: Db

beforeEach(() => {
  db = makeDb()
})

/** db.refresh(tx): rows here are snapshots, so read the row again. */
function reload(tx: Transaction): Transaction {
  const row = db.select().from(transactions).where(eq(transactions.id, tx.id)).get()
  if (row === undefined) throw new Error(`Transaction ${tx.id} is gone`)
  return row
}

describe('matchTransfers', () => {
  it('pairs the fixture card payments and savings transfers', () => {
    const loaded = loadSimplefinFixture(db)
    const marked = matchTransfers(db)
    const txs = loaded.map(reload)
    const transfers = txs.filter((t) => t.is_transfer)
    expect(transfers.length).toBeGreaterThan(0)
    expect(marked).toBe(transfers.length)
    const byId = new Map(txs.map((t) => [t.id, t]))
    for (const t of transfers) {
      const other = byId.get(t.transfer_pair_id as number)
      if (other === undefined) throw new Error(`No pair for ${t.id}`)
      expect(other.transfer_pair_id).toBe(t.id)
      expect(other.account_id).not.toBe(t.account_id)
      expect(other.amount).toBe(-t.amount)
      expect(Math.abs(daysBetween(t.posted_on, other.posted_on))).toBeLessThanOrEqual(3)
    }
    const descriptions = new Set(transfers.map((t) => t.raw_description.split(' ')[0]))
    expect(descriptions).toEqual(new Set(['PAYMENT', 'ONLINE', 'AUTOMATIC']))
    expect(transfers.filter((t) => t.raw_description.includes('CHASE CARD'))).toHaveLength(6)
    expect(transfers.filter((t) => t.raw_description.includes('SAV'))).toHaveLength(6)
  })

  it('makes no false pairs in the fixture', () => {
    const loaded = loadSimplefinFixture(db)
    matchTransfers(db)
    const legit = ['PAYMENT TO CHASE', 'AUTOMATIC PAYMENT', 'ONLINE TRANSFER']
    for (const t of loaded.map(reload)) {
      if (t.is_transfer) {
        expect(legit.some((p) => t.raw_description.startsWith(p)), t.raw_description).toBe(true)
      } else {
        expect(legit.slice(1).some((p) => t.raw_description.startsWith(p)), t.raw_description).toBe(false)
      }
    }
  })

  it('is idempotent', () => {
    loadSimplefinFixture(db)
    expect(matchTransfers(db)).toBeGreaterThan(0)
    expect(matchTransfers(db)).toBe(0)
  })

  it('never pairs within one account', () => {
    const a = makeAccount(db)
    makeTx(db, a, '-50.00')
    makeTx(db, a, '50.00')
    expect(matchTransfers(db)).toBe(0)
  })

  it('uses a five-day window', () => {
    const a = makeAccount(db)
    const b = makeAccount(db, 'savings')
    const out = makeTx(db, a, '-80.00', 'SOME MERCHANT', '2026-01-10')
    const far = makeTx(db, b, '80.00', 'SOME MERCHANT', '2026-01-16')
    expect(matchTransfers(db)).toBe(0)
    const near = makeTx(db, b, '80.00', 'SOME MERCHANT', '2026-01-15')
    expect(matchTransfers(db)).toBe(2)
    expect(reload(out).transfer_pair_id).toBe(near.id)
    expect(reload(far).is_transfer).toBe(false)
  })

  it('prefers the closest date, then the lowest id', () => {
    const a = makeAccount(db)
    const b = makeAccount(db)
    const out = makeTx(db, a, '-20.00', 'SOME MERCHANT', '2026-02-10')
    const farther = makeTx(db, b, '20.00', 'SOME MERCHANT', '2026-02-12')
    const firstClose = makeTx(db, b, '20.00', 'SOME MERCHANT', '2026-02-11')
    const secondClose = makeTx(db, b, '20.00', 'SOME MERCHANT', '2026-02-11')
    matchTransfers(db)
    expect(reload(out).transfer_pair_id).toBe(firstClose.id)
    expect(reload(farther).is_transfer).toBe(false)
    expect(reload(secondClose).is_transfer).toBe(false)
  })

  it('skips pending and zero amounts', () => {
    const a = makeAccount(db)
    const b = makeAccount(db)
    makeTx(db, a, '-9.00', 'SOME MERCHANT', '2026-01-10', { pending: true })
    makeTx(db, b, '9.00')
    makeTx(db, a, '0.00')
    makeTx(db, b, '0.00')
    expect(matchTransfers(db)).toBe(0)
  })
})
