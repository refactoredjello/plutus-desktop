/**
 * The factories have no Python tests of their own; these pin the behaviour every ported test
 * relies on, read off api/tests/factories.py and api/tests/simplefin_helpers.py.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { categories, transactions } from '../src/db/schema.js'
import {
  ACCESS_URL,
  OWNER_TOKENS,
  categoryId,
  loadFixture,
  loadSimplefinFixture,
  makeAccount,
  makeToken,
  makeTx,
  mockFetch,
  settingsWithOwner,
} from './factories.js'
import { FIXTURES, makeDb } from './setup.js'

describe('makeAccount', () => {
  it('inserts a test checking account with a unique external id', () => {
    const db = makeDb()
    const a = makeAccount(db)
    const b = makeAccount(db, 'credit', 'Card')
    expect(a).toMatchObject({ provider: 'test', type: 'checking', name: 'Acct', currency: 'USD', is_active: true })
    expect(a.external_id).toMatch(/^A\d+$/)
    expect(b).toMatchObject({ type: 'credit', name: 'Card' })
    expect(b.external_id).not.toBe(a.external_id)
  })
})

describe('makeTx', () => {
  it('inserts a transaction with the Python defaults', () => {
    const db = makeDb()
    const account = makeAccount(db)
    const tx = makeTx(db, account, '-15.49')
    expect(tx).toMatchObject({
      account_id: account.id,
      amount: -1549,
      raw_description: 'SOME MERCHANT',
      posted_on: '2026-01-10',
      pending: false,
      is_transfer: false,
      merchant_key: null,
    })
    expect(tx.external_id).toMatch(/^T\d+$/)
  })

  it('passes extra columns through like **kwargs', () => {
    const db = makeDb()
    const account = makeAccount(db)
    const tx = makeTx(db, account, '100.00', 'PAYROLL', '2026-02-01', { merchant_key: 'ACME', pending: true })
    expect(tx).toMatchObject({ amount: 10000, raw_description: 'PAYROLL', posted_on: '2026-02-01', merchant_key: 'ACME', pending: true })
  })
})

describe('loadSimplefinFixture', () => {
  it('inserts every fixture transaction under three typed accounts', () => {
    const db = makeDb()
    const txs = loadSimplefinFixture(db)
    const fixture = loadFixture()
    const expected = fixture.accounts.reduce((n, a) => n + a.transactions.length, 0)
    expect(txs).toHaveLength(expected)
    expect(db.$client.prepare('SELECT count(*) FROM transactions').pluck().get()).toBe(expected)
    const types = db.$client.prepare('SELECT name, type FROM accounts ORDER BY id').all()
    expect(types).toEqual(fixture.accounts.map((a) => ({ name: a.name, type: { chk: 'checking', cc: 'credit', sav: 'savings' }[a.id.split('-')[1] ?? ''] })))
  })

  it('maps posted dates in UTC, blank payee and memo to null, and the pending flag', () => {
    const db = makeDb()
    const txs = loadSimplefinFixture(db)
    const first = txs[0]
    expect(first).toMatchObject({
      posted_on: '2026-03-07',
      amount: 285000,
      raw_description: 'ACME CORP PAYROLL PPD ID: 1234567890',
      payee: 'Acme Corp',
      memo: null,
    })
    const pending = txs.filter((t) => t.pending)
    expect(pending).toHaveLength(1)
    // posted is 0 for the pending transaction, so its date comes from transacted_at.
    const row = db.select().from(transactions).where(eq(transactions.id, pending[0]?.id ?? 0)).get()
    expect(row?.posted_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(row?.posted_on).not.toBe('1970-01-01')
  })
})

describe('categoryId', () => {
  it('finds a seeded category by detailed name', () => {
    const db = makeDb()
    const id = categoryId(db, 'FOOD_AND_DRINK_COFFEE')
    expect(db.select().from(categories).where(eq(categories.id, id)).get()?.label).toBe('Coffee')
  })

  it('throws when there is no such category, like .one()', () => {
    expect(() => categoryId(makeDb(), 'NOPE')).toThrow()
  })
})

describe('settingsWithOwner', () => {
  it('sets the fake owner tokens and the fake LLM', () => {
    expect(OWNER_TOKENS).toEqual(['ALEX', 'SAMPLE'])
    expect(settingsWithOwner().defaults).toMatchObject({ ownerNameTokens: ['ALEX', 'SAMPLE'], llmProvider: 'fake' })
  })
})

describe('SimpleFIN helpers', () => {
  it('loads the fixture JSON', () => {
    expect(loadFixture()).toEqual(JSON.parse(readFileSync(join(FIXTURES, 'simplefin_accounts.json'), 'utf8')))
  })

  it('makes a base64 setup token from a claim URL', () => {
    expect(Buffer.from(makeToken(), 'base64').toString()).toBe('https://bridge.example/simplefin/claim/abc')
    expect(Buffer.from(makeToken('https://x.example/c'), 'base64').toString()).toBe('https://x.example/c')
  })

  it('has a fake access URL with credentials', () => {
    expect(ACCESS_URL).toBe('https://user123:pass456@bridge.example/simplefin')
  })

  it('mocks fetch with the fixture by default and records requests', async () => {
    const requests: Request[] = []
    const fetch = mockFetch(undefined, requests)
    const res = await fetch('https://bridge.example/simplefin/accounts?start-date=1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(loadFixture())
    expect(requests.map((r) => r.url)).toEqual(['https://bridge.example/simplefin/accounts?start-date=1'])
  })

  it('mocks fetch with a payload or a handler', async () => {
    expect(await (await mockFetch({ accounts: [], errors: [] })('https://x.example/')).json()).toEqual({ accounts: [], errors: [] })
    const handler = mockFetch((req) => new Response(req.method, { status: 403 }))
    const res = await handler('https://x.example/', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('POST')
  })
})
