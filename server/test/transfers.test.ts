/** Internal transfer matching. */

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/index.js'
import { transactions } from '../src/db/schema.js'
import { daysBetween } from '../src/lib/dates.js'
import { WINDOW_DAYS, matchTransfers } from '../src/services/transfers.js'
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
      expect(Math.abs(daysBetween(t.posted_on, other.posted_on))).toBeLessThanOrEqual(WINDOW_DAYS)
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

  it('pairs a card payment that posts four or five days later (backlog 21)', () => {
    const checking = makeAccount(db, 'checking')
    const card = makeAccount(db, 'credit')
    const out4 = makeTx(db, checking, '-917.51', 'PAYMENT TO CHASE CARD ENDING IN 4821', '2026-03-02')
    const in4 = makeTx(db, card, '917.51', 'AUTOMATIC PAYMENT - THANK YOU', '2026-03-06')
    const out5 = makeTx(db, checking, '-640.20', 'PAYMENT TO CHASE CARD ENDING IN 4821', '2026-04-02')
    const in5 = makeTx(db, card, '640.20', 'AUTOMATIC PAYMENT - THANK YOU', '2026-04-07')
    const out6 = makeTx(db, checking, '-312.00', 'PAYMENT TO CHASE CARD ENDING IN 4821', '2026-05-01')
    const in6 = makeTx(db, card, '312.00', 'AUTOMATIC PAYMENT - THANK YOU', '2026-05-07')
    expect(matchTransfers(db)).toBe(4)
    expect(reload(out4).transfer_pair_id).toBe(in4.id)
    expect(reload(out5).transfer_pair_id).toBe(in5.id)
    expect(reload(out6).is_transfer).toBe(false)
    expect(reload(in6).is_transfer).toBe(false)
  })
})

describe('matchTransfers needs a transfer signal (backlog 36)', () => {
  it('does not pair a refund on one card with a charge on another', () => {
    const cardA = makeAccount(db, 'credit')
    const cardB = makeAccount(db, 'credit')
    const refund = makeTx(db, cardA, '45.00', 'AMZN MKTP US REFUND', '2026-03-10')
    const charge = makeTx(db, cardB, '-45.00', 'TARGET 00012345 OAKLAND CA', '2026-03-11')
    expect(matchTransfers(db)).toBe(0)
    expect(reload(refund).is_transfer).toBe(false)
    expect(reload(charge).is_transfer).toBe(false)
  })

  it('pairs a checking-to-card payment with a payment word', () => {
    const checking = makeAccount(db, 'checking')
    const card = makeAccount(db, 'credit')
    const out = makeTx(db, checking, '-200.00', 'PAYMENT TO CHASE CARD', '2026-03-10')
    const inc = makeTx(db, card, '200.00', 'AUTOMATIC PAYMENT - THANK YOU', '2026-03-12')
    expect(matchTransfers(db)).toBe(2)
    expect(reload(out).transfer_pair_id).toBe(inc.id)
  })

  it('pairs a checking-to-card payment without a payment word', () => {
    const checking = makeAccount(db, 'checking')
    const card = makeAccount(db, 'credit')
    const out = makeTx(db, checking, '-200.00', 'CHASE CREDIT CRD EPAY', '2026-03-10')
    const inc = makeTx(db, card, '200.00', 'CHASE CRD EPAY', '2026-03-11')
    expect(matchTransfers(db)).toBe(2)
    expect(reload(inc).transfer_pair_id).toBe(out.id)
  })

  it('pairs savings or checking with a loan account without a payment word', () => {
    const savings = makeAccount(db, 'savings')
    const loan = makeAccount(db, 'loan')
    const out = makeTx(db, savings, '-350.00', 'SALLIE MAE', '2026-03-10')
    const inc = makeTx(db, loan, '350.00', 'SALLIE MAE', '2026-03-10')
    expect(matchTransfers(db)).toBe(2)
    expect(reload(out).transfer_pair_id).toBe(inc.id)
  })

  it('pairs two depository accounts without a payment word', () => {
    const checking = makeAccount(db, 'checking')
    const savings = makeAccount(db, 'savings')
    const out = makeTx(db, checking, '-500.00', 'TO SAV 7788', '2026-03-10')
    const inc = makeTx(db, savings, '500.00', 'FROM CHK 1234', '2026-03-10')
    expect(matchTransfers(db)).toBe(2)
    expect(reload(out).transfer_pair_id).toBe(inc.id)
  })

  it('pairs two cards only with a payment word', () => {
    const cardA = makeAccount(db, 'credit')
    const cardB = makeAccount(db, 'credit')
    makeTx(db, cardA, '-80.00', 'BALANCE MOVE', '2026-03-10')
    makeTx(db, cardB, '80.00', 'BALANCE MOVE', '2026-03-10')
    expect(matchTransfers(db)).toBe(0)
    const out = makeTx(db, cardA, '-60.00', 'CARD TO CARD', '2026-03-12')
    const inc = makeTx(db, cardB, '60.00', 'ONLINE PMT RECEIVED', '2026-03-12')
    expect(matchTransfers(db)).toBe(2)
    expect(reload(out).transfer_pair_id).toBe(inc.id)
  })

  it('reads the payee too, case-insensitively', () => {
    const cardA = makeAccount(db, 'credit')
    const cardB = makeAccount(db, 'credit')
    const out = makeTx(db, cardA, '-25.00', 'SOME MERCHANT', '2026-03-10', { payee: 'Zelle' })
    const inc = makeTx(db, cardB, '25.00', 'SOME MERCHANT', '2026-03-10')
    expect(matchTransfers(db)).toBe(2)
    expect(reload(out).transfer_pair_id).toBe(inc.id)
  })

  it.each([
    ['TRANSFER'],
    ['xfer'],
    ['PAYMENT'],
    ['PYMT'],
    ['AUTOPAY'],
    ['ONLINE PMT'],
    ['Thank You'],
    ['ACH'],
    ['ZELLE'],
  ])('counts %j as a signal between accounts of unknown type', (word) => {
    const a = makeAccount(db, 'other')
    const b = makeAccount(db, 'other')
    makeTx(db, a, '-10.00', `BANK ${word} 123`, '2026-03-10')
    makeTx(db, b, '10.00', 'BANK', '2026-03-10')
    expect(matchTransfers(db)).toBe(2)
  })

  it('matches the words as whole words', () => {
    const a = makeAccount(db, 'credit')
    const b = makeAccount(db, 'credit')
    makeTx(db, a, '-10.00', 'ACHIEVE FITNESS', '2026-03-10')
    makeTx(db, b, '10.00', 'PAYMENTUS REFUND', '2026-03-10', { payee: 'Bach Music' })
    expect(matchTransfers(db)).toBe(0)
  })

  it('does not pair accounts of unknown type without a word', () => {
    const a = makeAccount(db, 'other')
    const b = makeAccount(db, 'checking')
    makeTx(db, a, '-10.00', 'SOME MERCHANT', '2026-03-10')
    makeTx(db, b, '10.00', 'SOME MERCHANT', '2026-03-10')
    expect(matchTransfers(db)).toBe(0)
  })

  it('keeps the closest-date tie-break among candidates with a signal', () => {
    const checking = makeAccount(db, 'checking')
    const cardA = makeAccount(db, 'credit')
    const cardB = makeAccount(db, 'credit')
    const out = makeTx(db, cardA, '-30.00', 'SOME MERCHANT', '2026-03-10')
    // Closer, but card to card without a word: not a candidate.
    makeTx(db, cardB, '30.00', 'SOME MERCHANT', '2026-03-10')
    const viaChecking = makeTx(db, checking, '30.00', 'SOME MERCHANT', '2026-03-13')
    expect(matchTransfers(db)).toBe(2)
    expect(reload(out).transfer_pair_id).toBe(viaChecking.id)
  })

  it('with `only`, pairs a candidate only when one side is in it', () => {
    const checking = makeAccount(db, 'checking')
    const savings = makeAccount(db, 'savings')
    const oldOut = makeTx(db, checking, '-70.00', 'ONLINE TRANSFER', '2026-03-10')
    const oldIn = makeTx(db, savings, '70.00', 'ONLINE TRANSFER', '2026-03-10')
    expect(matchTransfers(db, new Set())).toBe(0)
    const newIn = makeTx(db, savings, '70.00', 'ONLINE TRANSFER', '2026-03-11')
    expect(matchTransfers(db, new Set([newIn.id]))).toBe(2)
    expect(reload(oldOut).transfer_pair_id).toBe(newIn.id)
    expect(reload(oldIn).is_transfer).toBe(false)
  })
})
