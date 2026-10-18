/**
 * Helpers that insert accounts and transactions directly, without the sync service, and
 * build SimpleFIN fixtures.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { Config } from '../src/config.js'
import type { Db } from '../src/db/index.js'
import { type AccountType, accounts, categories, transactions } from '../src/db/schema.js'
import { type PlainDate, epochToUtcDate, plainDate } from '../src/lib/dates.js'
import { parseMoney } from '../src/lib/money.js'
import { FIXTURES, testConfig } from './setup.js'

export type Account = typeof accounts.$inferSelect
export type Transaction = typeof transactions.$inferSelect
type TransactionExtra = Partial<Omit<typeof transactions.$inferInsert, 'account_id' | 'external_id' | 'posted_on' | 'amount' | 'raw_description'>>

export const OWNER_TOKENS = ['ALEX', 'SAMPLE']

const TYPES: Record<string, AccountType> = { chk: 'checking', cc: 'credit', sav: 'savings' }
let counter = 0

/** A config with the fake owner's name tokens and the fake LLM. */
export function settingsWithOwner(): Config {
  const config = testConfig()
  return { ...config, defaults: { ...config.defaults, ownerNameTokens: OWNER_TOKENS, llmProvider: 'fake' } }
}

export function makeAccount(db: Db, type: AccountType = 'checking', name = 'Acct'): Account {
  counter += 1
  return db.insert(accounts).values({ provider: 'test', external_id: `A${counter}`, name, type }).returning().get()
}

/** `amount` is a decimal string; `extra` overrides any column. */
export function makeTx(
  db: Db,
  account: Account,
  amount: string,
  description = 'SOME MERCHANT',
  postedOn: PlainDate | string = '2026-01-10',
  extra: TransactionExtra = {},
): Transaction {
  counter += 1
  return db
    .insert(transactions)
    .values({
      account_id: account.id,
      external_id: `T${counter}`,
      posted_on: plainDate(postedOn),
      amount: parseMoney(amount),
      raw_description: description,
      ...extra,
    })
    .returning()
    .get()
}

export interface SimpleFINTransaction {
  id: string
  posted: number
  amount: string
  description: string
  payee: string
  memo: string
  transacted_at: number
  pending: boolean
}

export interface SimpleFINAccount {
  id: string
  name: string
  currency: string
  balance: string
  'available-balance': string
  'balance-date': number
  org: Record<string, string>
  holdings: unknown[]
  transactions: SimpleFINTransaction[]
}

export interface SimpleFINPayload {
  errors: string[]
  accounts: SimpleFINAccount[]
}

/** The fake SimpleFIN /accounts response. */
export function loadFixture(): SimpleFINPayload {
  return JSON.parse(readFileSync(join(FIXTURES, 'simplefin_accounts.json'), 'utf8')) as SimpleFINPayload
}

export function loadSimplefinFixture(db: Db): Transaction[] {
  const data = loadFixture()
  const txs: Transaction[] = []
  for (const acct of data.accounts) {
    const type = TYPES[acct.id.split('-')[1] ?? '']
    if (type === undefined) throw new Error(`Unknown fixture account kind: ${acct.id}`)
    const account = makeAccount(db, type, acct.name)
    for (const t of acct.transactions) {
      const stamp = t.posted || t.transacted_at
      txs.push(
        makeTx(db, account, t.amount, t.description, epochToUtcDate(stamp), {
          payee: t.payee || null,
          memo: t.memo || null,
          pending: t.pending,
        }),
      )
    }
  }
  return txs
}

/** category_id: the id of a category by detailed name; throws unless exactly one matches. */
export function categoryId(db: Db, detailed: string): number {
  const rows = db.select({ id: categories.id }).from(categories).where(eq(categories.detailed, detailed)).all()
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error(`Expected one category ${detailed}, found ${rows.length}`)
  }
  return rows[0].id
}

// SimpleFIN helpers

export const ACCESS_URL = 'https://user123:pass456@bridge.example/simplefin'

export function makeToken(claimUrl = 'https://bridge.example/simplefin/claim/abc'): string {
  return Buffer.from(claimUrl).toString('base64')
}

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * mock_client: a fetch that answers every request with `payload` as JSON (the fixture by
 * default), or with what a handler returns, and records each request in `requests`.
 */
export type FetchHandler = (request: Request) => Response | Promise<Response>

export function mockFetch(payload?: FetchHandler | SimpleFINPayload | Record<string, unknown>, requests?: Request[]): FetchFn {
  const body = payload ?? loadFixture()
  return async (input, init) => {
    const request = new Request(input, init)
    requests?.push(request)
    if (typeof body === 'function') return body(request)
    return Response.json(body, { status: 200 })
  }
}
