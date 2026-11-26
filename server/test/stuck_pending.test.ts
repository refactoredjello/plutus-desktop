/**
 * Pending rows that outlive the sync overlap (backlog: stuck pending).
 *
 * A fake bank keeps entries and answers like SimpleFIN: a pending entry comes back on every
 * request, a posted one only when its posted date is inside the requested range. Syncs run
 * daily at 09:00 UTC with the clock and "today" pinned to that day.
 */

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/db/index.js'
import { categorizations, transactions } from '../src/db/schema.js'
import { type PlainDate, addDays, utcNow } from '../src/lib/dates.js'
import { parseMoney } from '../src/lib/money.js'
import { chunkRanges } from '../src/providers/bank/simplefin.js'
import type { BankProvider, ProviderSnapshot, ProviderTransaction } from '../src/providers/bank/types.js'
import { KeySecretStore } from '../src/secrets.js'
import { PENDING_REACH_DAYS } from '../src/services/pending.js'
import { monthDetail } from '../src/services/reports.js'
import * as sync from '../src/services/sync.js'
import { listTransactions } from '../src/services/transactions.js'
import { categoryId, makeAccount, makeTx } from './factories.js'
import { makeApp, makeDb, testConfig } from './setup.js'

const config = testConfig()
const secrets = new KeySecretStore(config.secretKey)
let db: Db

beforeEach(() => {
  db = makeDb()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

interface Entry {
  id: string
  account?: string
  amount?: string
  day: PlainDate // the transaction date; a posted entry is dated here unless `postedOn` says otherwise
  postedOn?: PlainDate | null // null while pending
}

class Bank implements BankProvider {
  readonly name = 'simplefin'
  requestsMade = 0
  entries: Entry[] = []
  errors: string[] = []
  windows: [PlainDate, PlainDate][] = []

  async fetch(start: PlainDate, end: PlainDate): Promise<ProviderSnapshot> {
    this.windows.push([start, end])
    this.requestsMade += chunkRanges(start, end).length
    const byAccount = new Map<string, ProviderTransaction[]>([['CARD1', []]])
    for (const e of this.entries) {
      const pending = e.postedOn === null || e.postedOn === undefined
      const on = pending ? e.day : (e.postedOn as PlainDate)
      if (!pending && (on < start || on > end)) continue
      const acct = e.account ?? 'CARD1'
      if (!byAccount.has(acct)) byAccount.set(acct, [])
      byAccount.get(acct)!.push({
        external_id: e.id,
        posted_on: on,
        amount: parseMoney(e.amount ?? '-15.00'),
        description: 'MONTHLY FEE',
        payee: null,
        memo: null,
        pending,
        transacted_at: `${e.day}T12:00:00.000Z`,
      })
    }
    return {
      accounts: [...byAccount].map(([id, txs]) => ({
        external_id: id,
        name: 'Visa Card',
        type: 'credit' as const,
        institution_name: 'Bank',
        currency: 'USD',
        balance: parseMoney('0'),
        available: null,
        balance_as_of: '2026-10-01T00:00:00.000Z',
        transactions: txs,
      })),
      errors: this.errors,
    }
  }
}

async function syncOn(bank: Bank, day: PlainDate) {
  vi.spyOn(sync.syncClock, 'now').mockReturnValue(new Date(`${day}T09:00:00.000Z`))
  vi.stubEnv('PLUTUS_TODAY', day)
  bank.requestsMade = 0
  return sync.runSync(db, secrets, config.defaults, bank, 'scheduled')
}

async function syncDaily(bank: Bank, from: PlainDate, to: PlainDate) {
  for (let d = from; d <= to; d = addDays(d, 1)) await syncOn(bank, d)
}

const d = (s: string) => s as PlainDate
const byExt = (ext: string) => db.select().from(transactions).where(eq(transactions.external_id, ext)).get()
const catOf = (id: number) => db.select().from(categorizations).where(eq(categorizations.transaction_id, id)).get()
const pendingRows = () => db.select().from(transactions).where(eq(transactions.pending, true)).all()

function editByHand(id: number, note = 'Gym, annual plan') {
  db.delete(categorizations).where(eq(categorizations.transaction_id, id)).run()
  db.insert(categorizations)
    .values({
      transaction_id: id,
      category_id: categoryId(db, 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS'),
      essentiality: 'flexible',
      source: 'manual',
      confidence: 'very_high',
      updated_at: utcNow(),
    })
    .run()
  db.update(transactions).set({ note, one_time: true }).where(eq(transactions.id, id)).run()
}

function reviewIds(): number[] {
  const [items] = listTransactions(db, {
    q: null,
    start: null,
    end: null,
    account_ids: null,
    category_ids: null,
    essentiality: null,
    uncategorized: false,
    needs_review: true,
    include_transfers: false,
    limit: 500,
    offset: 0,
  })
  return items.map((t) => t.id)
}

/** History load on Oct 3; the Oct 15 fee shows up pending on Oct 17 and stays pending six daily syncs. */
async function ownerSequence(bank: Bank) {
  bank.entries = [{ id: 'FEE-09', day: d('2026-09-15'), postedOn: d('2026-09-15') }]
  await syncOn(bank, d('2026-10-03'))
  bank.entries.push({ id: 'FEE-10', day: d('2026-10-15'), postedOn: null })
  await syncOn(bank, d('2026-10-17'))
  const pending = byExt('FEE-10')!
  editByHand(pending.id)
  await syncDaily(bank, d('2026-10-18'), d('2026-10-22'))
  expect(byExt('FEE-10')!.pending).toBe(true)
  return pending
}

describe('sync window reaches old pending rows', () => {
  it('owner sequence, posted under the same id: updated in place, edits intact', async () => {
    const bank = new Bank()
    const pending = await ownerSequence(bank)
    // The bank posts it, dated back to the 15th, outside the 5-day overlap.
    bank.entries[1]!.postedOn = d('2026-10-15')
    await syncDaily(bank, d('2026-10-23'), d('2026-10-25'))

    const row = byExt('FEE-10')!
    expect(row.id).toBe(pending.id)
    expect(row.pending).toBe(false)
    expect(row.note).toBe('Gym, annual plan')
    expect(catOf(row.id)).toMatchObject({ source: 'manual', essentiality: 'flexible' })
    expect(pendingRows()).toHaveLength(0)
    expect(monthDetail(db, '2026-10').expenses).toBe('15.00')
  })

  it('owner sequence, posted under a new id: one posted row carrying the edits', async () => {
    const bank = new Bank()
    await ownerSequence(bank)
    bank.entries[1] = { id: 'FEE-10-POSTED', day: d('2026-10-15'), postedOn: d('2026-10-15') }
    await syncOn(bank, d('2026-10-23'))

    expect(byExt('FEE-10')).toBeUndefined()
    const posted = byExt('FEE-10-POSTED')!
    expect(posted.pending).toBe(false)
    expect(posted.note).toBe('Gym, annual plan')
    expect(posted.one_time).toBe(true)
    expect(catOf(posted.id)).toMatchObject({
      source: 'manual',
      category_id: categoryId(db, 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS'),
    })
    expect(db.select().from(transactions).all().filter((t) => t.posted_on.startsWith('2026-10'))).toHaveLength(1)
  })

  it('a hold the bank stops returning is dropped by the wider window', async () => {
    const bank = new Bank()
    await ownerSequence(bank)
    bank.entries.pop()
    await syncOn(bank, d('2026-10-23'))
    expect(byExt('FEE-10')).toBeUndefined()
  })

  it('ambiguous twins carry nothing', async () => {
    const bank = new Bank()
    await ownerSequence(bank)
    bank.entries[1] = { id: 'FEE-10-A', day: d('2026-10-15'), postedOn: d('2026-10-16') }
    bank.entries.push({ id: 'FEE-10-B', day: d('2026-10-15'), postedOn: d('2026-10-17') })
    await syncOn(bank, d('2026-10-23'))
    expect(byExt('FEE-10')).toBeUndefined()
    expect(byExt('FEE-10-A')!.note).toBeNull()
    expect(byExt('FEE-10-B')!.note).toBeNull()
    expect(catOf(byExt('FEE-10-A')!.id)?.source).not.toBe('manual')
  })

  it('a sync with provider errors drops nothing', async () => {
    const bank = new Bank()
    await ownerSequence(bank)
    bank.entries.pop()
    bank.errors = ['Another bank needs attention']
    await syncOn(bank, d('2026-10-23'))
    expect(byExt('FEE-10')!.pending).toBe(true)
  })

  it('a normal sync stays at one request however old the pending row', async () => {
    const bank = new Bank()
    await ownerSequence(bank)
    // The bank keeps it pending for months; sync daily until well past the reach.
    await syncDaily(bank, d('2026-10-23'), d('2026-12-15'))
    expect(bank.windows.slice(1).every(([start, end]) => chunkRanges(start, end).length === 1)).toBe(true)
    const last = bank.windows.at(-1)!
    expect(last[0]).toBe(addDays(d('2026-12-15'), -sync.OVERLAP_DAYS - 1))
    // While it was within reach, the window started at the pending row's date.
    expect(bank.windows.find(([, end]) => end === '2026-11-20')![0]).toBe('2026-10-15')
  })
})

describe('pending rows beyond reach', () => {
  async function stuckBeyondReach(bank: Bank) {
    await ownerSequence(bank)
    // The bank stops returning the pending entry without our noticing (an older app version
    // whose window never reached it): emulate by leaving it and syncing past the reach.
    await syncDaily(bank, d('2026-10-23'), d('2026-10-23'))
    bank.errors = ['Another bank needs attention'] // keep the drop from firing while in reach
    bank.entries.pop()
    const last = addDays(d('2026-10-15'), PENDING_REACH_DAYS + 2)
    await syncOn(bank, last)
    bank.errors = []
    return last
  }

  it('without a twin stays pending and shows in review with a reason', async () => {
    const bank = new Bank()
    const last = await stuckBeyondReach(bank)
    await syncOn(bank, addDays(last, 1))
    const row = byExt('FEE-10')!
    expect(row.pending).toBe(true)
    expect(reviewIds()).toContain(row.id)
    expect(monthDetail(db, '2026-10').review_count).toBe(1)
    const ctx = makeApp({ db })
    const body = (await (await ctx.app.request('/api/transactions?needs_review=true')).json()) as {
      items: { id: number; review_reason: string | null }[]
    }
    expect(body.items.find((t) => t.id === row.id)?.review_reason).toBe(`Pending for over ${PENDING_REACH_DAYS} days`)
  })

  it('with an unambiguous posted twin is dropped, carrying edits', async () => {
    const bank = new Bank()
    await ownerSequence(bank)
    // The posted twin arrived while errors kept the pending row; now it is beyond reach.
    bank.errors = ['Another bank needs attention']
    bank.entries[1] = { id: 'FEE-10-POSTED', day: d('2026-10-15'), postedOn: d('2026-10-18') }
    await syncOn(bank, d('2026-10-23'))
    await syncOn(bank, addDays(d('2026-10-15'), PENDING_REACH_DAYS + 2))
    bank.errors = []
    await syncOn(bank, addDays(d('2026-10-15'), PENDING_REACH_DAYS + 3))
    expect(byExt('FEE-10')).toBeUndefined()
    expect(byExt('FEE-10-POSTED')!.note).toBe('Gym, annual plan')
  })

  it('never overwrites a manual value already on the posted twin', async () => {
    const bank = new Bank()
    await ownerSequence(bank)
    bank.errors = ['Another bank needs attention']
    bank.entries[1] = { id: 'FEE-10-POSTED', day: d('2026-10-15'), postedOn: d('2026-10-18') }
    await syncOn(bank, d('2026-10-23'))
    const posted = byExt('FEE-10-POSTED')!
    db.update(transactions).set({ note: 'Mine' }).where(eq(transactions.id, posted.id)).run()
    await syncOn(bank, addDays(d('2026-10-15'), PENDING_REACH_DAYS + 2))
    bank.errors = []
    await syncOn(bank, addDays(d('2026-10-15'), PENDING_REACH_DAYS + 3))
    expect(byExt('FEE-10')).toBeUndefined()
    expect(byExt('FEE-10-POSTED')!.note).toBe('Mine')
    expect(byExt('FEE-10-POSTED')!.one_time).toBe(true)
    expect(catOf(posted.id)?.source).toBe('manual')
  })

  it('with ambiguous twins is left alone', async () => {
    const bank = new Bank()
    await ownerSequence(bank)
    bank.errors = ['Another bank needs attention']
    bank.entries[1] = { id: 'FEE-10-A', day: d('2026-10-15'), postedOn: d('2026-10-16') }
    bank.entries.push({ id: 'FEE-10-B', day: d('2026-10-15'), postedOn: d('2026-10-18') })
    await syncOn(bank, d('2026-10-23'))
    await syncOn(bank, addDays(d('2026-10-15'), PENDING_REACH_DAYS + 2))
    bank.errors = []
    await syncOn(bank, addDays(d('2026-10-15'), PENDING_REACH_DAYS + 3))
    expect(byExt('FEE-10')!.pending).toBe(true)
  })
})

describe('owner actions on a pending transaction', () => {
  function setup() {
    vi.stubEnv('PLUTUS_TODAY', '2026-11-25')
    const ctx = makeApp()
    const acct = makeAccount(ctx.db, 'credit')
    const pending = makeTx(ctx.db, acct, '-15.00', 'MONTHLY FEE', '2026-10-15', { pending: true })
    const posted = makeTx(ctx.db, acct, '-20.00', 'OTHER', '2026-10-16')
    return { ...ctx, pending, posted }
  }

  it('mark-posted counts the row in totals', async () => {
    const { app, db: appDb, pending } = setup()
    expect(monthDetail(appDb, '2026-10').expenses).toBe('20.00')
    const r = await app.request(`/api/transactions/${pending.id}/mark-posted`, { method: 'POST' })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ id: pending.id, pending: false, review_reason: null })
    expect(monthDetail(appDb, '2026-10').expenses).toBe('35.00')
  })

  it('remove deletes a pending row', async () => {
    const { app, db: appDb, pending } = setup()
    const r = await app.request(`/api/transactions/${pending.id}`, { method: 'DELETE' })
    expect(r.status).toBe(204)
    expect(appDb.select().from(transactions).where(eq(transactions.id, pending.id)).get()).toBeUndefined()
    expect(monthDetail(appDb, '2026-10').expenses).toBe('20.00')
  })

  it('both are refused for a posted row, and 404 for an unknown one', async () => {
    const { app, db: appDb, posted } = setup()
    expect((await app.request(`/api/transactions/${posted.id}/mark-posted`, { method: 'POST' })).status).toBe(409)
    expect((await app.request(`/api/transactions/${posted.id}`, { method: 'DELETE' })).status).toBe(409)
    expect(appDb.select().from(transactions).where(eq(transactions.id, posted.id)).get()).toBeDefined()
    expect((await app.request('/api/transactions/9999/mark-posted', { method: 'POST' })).status).toBe(404)
    expect((await app.request('/api/transactions/9999', { method: 'DELETE' })).status).toBe(404)
  })

  it('a later sync keeps a manually posted row posted unless the bank returns it pending', async () => {
    const bank = new Bank()
    const pending = await ownerSequence(bank)
    const ctx = makeApp({ db })
    expect((await ctx.app.request(`/api/transactions/${pending.id}/mark-posted`, { method: 'POST' })).status).toBe(200)
    // The bank still says pending: the bank wins.
    await syncOn(bank, d('2026-10-23'))
    expect(byExt('FEE-10')!.pending).toBe(true)
    // Marked again and never returned again: it stays posted.
    await ctx.app.request(`/api/transactions/${pending.id}/mark-posted`, { method: 'POST' })
    bank.entries.pop()
    await syncDaily(bank, d('2026-10-24'), d('2026-10-26'))
    expect(byExt('FEE-10')!.pending).toBe(false)
  })
})
