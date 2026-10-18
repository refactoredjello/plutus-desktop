/**
 * What changed (R12): one positive and one negative case per signal, plus dismissal.
 *
 * Pinned values besides: money() and shortDate() formatting, threshold equality for S1, S4, S8, the half-even
 * percentage at a tie, S6's half-cent median threshold, label fallbacks, and the href encoding.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { count } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/db/index.js'
import {
  type AccountType,
  type Cadence,
  type Essentiality,
  balanceSnapshots,
  categorizations,
  changeDismissals,
  manualEntries,
  recurrences,
} from '../src/db/schema.js'
import { type PlainDate, addDays, plainDate, utcNow } from '../src/lib/dates.js'
import { cents, parseMoney } from '../src/lib/money.js'
import { ClaudeProvider } from '../src/providers/llm/claude.js'
import { FakeLLMProvider } from '../src/providers/llm/fake.js'
import { OllamaProvider } from '../src/providers/llm/ollama.js'
import type { ChangeItem, ChangesRead } from '../src/schemas/changes.js'
import * as changes from '../src/services/changes.js'
import { type Account, categoryId, loadSimplefinFixture, makeAccount, makeTx } from './factories.js'
import { makeApp } from './setup.js'

const TODAY = plainDate('2026-10-20') // in-progress month: day 20 of 31
const d = (s: string): PlainDate => plainDate(s)

let ctx: ReturnType<typeof makeApp>
let db: Db

// fixed_today: schedule.today() is pinned through PLUTUS_TODAY.
beforeEach(() => {
  vi.stubEnv('PLUTUS_TODAY', TODAY)
  ctx = makeApp()
  db = ctx.db
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function items(signal: string): ChangeItem[] {
  return changes.compute(db, TODAY, { includeAll: true }).items.filter((i) => i.signal === signal)
}

/** Factory categorizations default to unknown confidence; most tests don't want S7 noise. */
function confident(): void {
  db.update(categorizations).set({ confidence: 'very_high' }).run()
}

/** Categorize a transaction directly, as the aggregates tests do. */
function categorize(txId: number, detailed: string, ess: Essentiality | null = null): void {
  db.insert(categorizations)
    .values({ transaction_id: txId, category_id: categoryId(db, detailed), essentiality: ess, source: 'manual', updated_at: utcNow() })
    .run()
}

interface RecurrenceOptions {
  cadence?: Cadence
  next_expected_date?: string
  last_seen_on?: string
}

function recurrence(account: Account, key: string, amount: string, kw: RecurrenceOptions = {}) {
  return db
    .insert(recurrences)
    .values({
      merchant_key: key,
      account_id: account.id,
      amount: parseMoney(amount),
      cadence: kw.cadence ?? 'monthly',
      next_expected_date: d(kw.next_expected_date ?? '2026-11-03'),
      last_seen_on: d(kw.last_seen_on ?? '2026-10-03'),
      status: 'confirmed',
    })
    .returning()
    .get()
}

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

const account = (type: AccountType = 'checking') => makeAccount(db, type)

// --- S1 recurring amount changed ----------------------------------------------------------

describe('S1 recurring amount changed', () => {
  it('S1 recurring amount changed', () => {
    const acct = account('credit')
    const charge = recurrence(acct, 'NETFLIX.COM CA', '-15.49')
    makeTx(db, acct, '-22.99', 'NETFLIX.COM', '2026-10-03', { merchant_key: 'NETFLIX.COM CA', payee: 'Netflix' })
    const found = items('S1')
    expect(found).toHaveLength(1)
    const item = found[0] as ChangeItem
    expect(item.text).toBe('Netflix went from $15.49 to $22.99.')
    expect(item.key).toBe(`S1:recurrence:${charge.id}:2299`)
    expect(item.href).toBe('/recurring')
  })

  it('S1 small change ignored', () => {
    const acct = account('credit')
    recurrence(acct, 'NETFLIX.COM CA', '-15.49')
    makeTx(db, acct, '-15.99', 'NETFLIX.COM', '2026-10-03', { merchant_key: 'NETFLIX.COM CA' })
    expect(items('S1')).toEqual([])
  })

  it('a change of exactly 10% or exactly $5 is ignored', () => {
    const acct = account('credit')
    for (const [key, base, latest] of [
      ['TEN PCT', '-100.00', '-110.00'],
      ['TEN PCT PLUS', '-100.00', '-110.01'],
      ['FIVE', '-15.00', '-20.00'],
      ['FIVE PLUS', '-15.00', '-20.01'],
    ] as const) {
      recurrence(acct, key, base)
      makeTx(db, acct, latest, 'X', '2026-10-03', { merchant_key: key })
    }
    expect(items('S1').map((i) => [i.text, i.key.split(':')[3]])).toEqual([
      ['Ten Pct Plus went from $100 to $110.', '11001'],
      ['Five Plus went from $15.00 to $20.01.', '2001'],
    ])
  })
})

// --- S2 recurring charge missing ----------------------------------------------------------

describe('S2 recurring charge missing', () => {
  it('S2 missing recurring charge', () => {
    const acct = account()
    recurrence(acct, 'PLANET FITNESS', '-24.99', { next_expected_date: '2026-10-05', last_seen_on: '2026-09-05' })
    const found = items('S2')
    expect(found).toHaveLength(1)
    expect(found[0]?.text).toBe("Planet Fitness hasn't posted; expected Oct 5.")
    expect(found[0]?.href).toBe('/recurring')
  })

  it('S2 not yet overdue or lapsed', () => {
    const acct = account()
    recurrence(acct, 'WITHIN GRACE', '-10.00', { next_expected_date: '2026-10-15', last_seen_on: '2026-09-15' })
    recurrence(acct, 'LONG GONE', '-10.00', { next_expected_date: '2026-07-01', last_seen_on: '2026-06-01' })
    expect(items('S2')).toEqual([])
  })
})

// --- S3 planned item overdue --------------------------------------------------------------

function entry(amount: string, due: string, kw: { description?: string; fulfilled_transaction_id?: number; recurrence?: 'monthly' } = {}) {
  return db
    .insert(manualEntries)
    .values({
      amount: parseMoney(amount),
      description: kw.description ?? 'Car insurance',
      due_date: d(due),
      ...(kw.fulfilled_transaction_id === undefined ? {} : { fulfilled_transaction_id: kw.fulfilled_transaction_id }),
      ...(kw.recurrence === undefined ? {} : { recurrence: kw.recurrence }),
    })
    .returning()
    .get()
}

describe('S3 planned item overdue', () => {
  it('S3 planned item overdue', () => {
    entry('-412.00', '2026-10-01')
    const found = items('S3')
    expect(found).toHaveLength(1)
    expect(found[0]?.text).toBe("Car insurance ($412) was due Oct 1 and hasn't matched a transaction.")
    expect(found[0]?.href).toBe('/planned')
  })

  it('S3 future fulfilled or recurring ignored', () => {
    const acct = account()
    const paid = makeTx(db, acct, '-412.00', 'INSURER', '2026-10-01')
    entry('-412.00', '2026-10-01', { fulfilled_transaction_id: paid.id })
    entry('-50.00', '2026-10-25')
    entry('-30.00', '2026-09-01', { recurrence: 'monthly' })
    expect(items('S3')).toEqual([])
  })
})

// --- S4 category well above usual ---------------------------------------------------------

function coffee(acct: Account, amount: string, day: string): void {
  const tx = makeTx(db, acct, amount, 'COFFEE', day)
  categorize(tx.id, 'FOOD_AND_DRINK_COFFEE', 'discretionary')
}

function history(acct: Account, monthly: string): void {
  for (const month of ['07', '08', '09']) coffee(acct, monthly, `2026-${month}-10`)
}

describe('S4 category well above usual', () => {
  it('S4 category above usual pace', () => {
    const acct = account()
    history(acct, '-100.00')
    coffee(acct, '-200.00', '2026-10-05')
    confident()
    const found = items('S4')
    expect(found).toHaveLength(1)
    const item = found[0] as ChangeItem
    // usual by day 20 (history on the 10th): 100; 200 is 100% above it
    expect(item.text).toBe('Coffee is $200 so far, 100% above your usual pace.')
    expect(item.href).toContain('start=2026-10-01')
    expect(item.href).toContain('end=2026-10-31')
    expect(item.href).toContain('category=')
  })

  it('S4 no history or below thresholds ignored', () => {
    const acct = account()
    coffee(acct, '-200.00', '2026-10-05')
    confident()
    expect(items('S4')).toEqual([]) // no prior months: S4 is skipped (R12.7)
  })

  it('S4 under dollar floor ignored', () => {
    const acct = account()
    history(acct, '-150.00')
    coffee(acct, '-210.00', '2026-10-05') // usual 150: 40% above but only $60
    confident()
    expect(items('S4')).toEqual([])
  })

  it('S4 under percentage ignored', () => {
    const acct = account()
    history(acct, '-1000.00')
    coffee(acct, '-1200.00', '2026-10-05') // usual 1000: $200 over but only 20%
    confident()
    expect(items('S4')).toEqual([])
  })

  it.each([
    ['-300.00', '-390.00', []], // exactly 30% above
    ['-300.00', '-390.01', ['Coffee is $390 so far, 30% above your usual pace.']],
    ['-200.00', '-275.00', []], // exactly $75 above
    ['-200.00', '-275.01', ['Coffee is $275 so far, 38% above your usual pace.']],
  ])('usual %s, now %s: thresholds are strict', (hist, now, expected) => {
    const acct = account()
    history(acct, hist)
    coffee(acct, now, '2026-10-05')
    confident()
    expect(items('S4').map((i) => i.text)).toEqual(expected)
  })

  it.each([
    ['-401.00', 'Coffee is $401 so far, 100% above your usual pace.'], // 100.5% rounds to even
    ['-403.00', 'Coffee is $403 so far, 102% above your usual pace.'], // 101.5% rounds to even
  ])('the percentage rounds half to even at a tie: %s', (now, text) => {
    const acct = account()
    history(acct, '-200.00')
    coffee(acct, now, '2026-10-05')
    confident()
    expect(items('S4').map((i) => i.text)).toEqual([text])
  })

  it('S4 bill paid early each month is not above pace', () => {
    // Regression from real data: a loan paid on the 1st looked 675% above a prorated pace.
    vi.stubEnv('PLUTUS_TODAY', '2026-10-04')
    const acct = account()
    for (const month of ['07', '08', '09', '10']) {
      const tx = makeTx(db, acct, '-3000.00', 'LOAN', `2026-${month}-01`, { merchant_key: 'CREDIT UNION LOAN' })
      categorize(tx.id, 'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT', 'essential')
    }
    confident()
    const result = changes.compute(db, d('2026-10-04'), { includeAll: true })
    expect(result.items.filter((i) => i.signal === 'S4')).toEqual([])
  })
})

// --- S5 new large merchant ----------------------------------------------------------------

describe('S5 new large merchant', () => {
  it('S5 new large merchant', () => {
    const acct = account()
    const tx = makeTx(db, acct, '-486.00', 'THE HOME DEPOT #123', '2026-10-02', {
      merchant_key: 'THE HOME DEPOT',
      payee: 'Home Depot',
    })
    categorize(tx.id, 'HOME_IMPROVEMENT_HARDWARE')
    confident()
    const found = items('S5')
    expect(found).toHaveLength(1)
    expect(found[0]?.text).toBe('First purchase at Home Depot: $486.')
    expect(found[0]?.href).toContain('q=Home+Depot')
  })

  it('S5 known merchant or small purchase ignored', () => {
    const acct = account()
    makeTx(db, acct, '-50.00', 'THE HOME DEPOT', '2026-09-02', { merchant_key: 'THE HOME DEPOT' })
    makeTx(db, acct, '-486.00', 'THE HOME DEPOT', '2026-10-02', { merchant_key: 'THE HOME DEPOT' })
    makeTx(db, acct, '-150.00', 'NEW SHOP', '2026-10-03', { merchant_key: 'NEW SHOP' })
    expect(items('S5')).toEqual([])
  })

  it('an empty payee falls back to the capitalised key, and q to the raw text', () => {
    const acct = account()
    makeTx(db, acct, '-486.00', 'the  HOME depot #12', '2026-10-02', { merchant_key: 'THE HOME DEPOT', payee: '' })
    makeTx(db, acct, '-500.00', 'raw only desc', '2026-10-03')
    expect(items('S5').map((i) => [i.text, i.href])).toEqual([
      ['First purchase at The Home Depot: $486.', '/transactions?q=the++HOME+depot+%2312&start=2026-10-01&end=2026-10-31'],
    ])
  })
})

// --- S6 large single expense --------------------------------------------------------------

function smallExpenses(acct: Account): void {
  for (let i = 0; i < 20; i++) makeTx(db, acct, '-20.00', 'LUNCH', addDays(d('2026-09-01'), i), { merchant_key: 'LUNCH' })
}

describe('S6 large single expense', () => {
  it('S6 large single expense', () => {
    const acct = account()
    smallExpenses(acct)
    makeTx(db, acct, '-300.00', 'DELTA', '2026-08-01', { merchant_key: 'DELTA AIR LINES', payee: 'Delta Air Lines' })
    makeTx(db, acct, '-1200.00', 'DELTA', '2026-10-02', { merchant_key: 'DELTA AIR LINES', payee: 'Delta Air Lines' })
    const found = items('S6')
    expect(found).toHaveLength(1)
    expect(found[0]?.text).toBe('$1,200 to Delta Air Lines on Oct 2.')
    expect(items('S5')).toEqual([]) // Delta was seen before, so it's S6 not S5
  })

  it('S6 recurring or below floor ignored', () => {
    const acct = account()
    smallExpenses(acct)
    recurrence(acct, 'CONDO FEE', '-1500.00')
    makeTx(db, acct, '-1500.00', 'CONDO', '2026-10-01', { merchant_key: 'CONDO FEE' })
    makeTx(db, acct, '-240.00', 'OLD SHOP', '2026-10-02', { merchant_key: 'LUNCH' }) // under $250
    expect(items('S6')).toEqual([])
  })

  it('S6 regular large charge is not unusual', () => {
    const acct = account()
    smallExpenses(acct)
    for (const month of ['08', '09', '10']) {
      makeTx(db, acct, '-3000.00', 'LOAN', `2026-${month}-01`, { merchant_key: 'CREDIT UNION LOAN' })
    }
    expect(items('S6')).toEqual([])
  })

  it.each([
    ['-300.01', []],
    ['-300.02', ['$300 to Big Store on Oct 2.']],
  ])('the median keeps its half cent: threshold 3 x 100.005, expense %s', (big, expected) => {
    const acct = account()
    makeTx(db, acct, '-50.00', 'A', '2026-09-01')
    makeTx(db, acct, '-100.00', 'B', '2026-09-02')
    makeTx(db, acct, '-100.01', 'C', '2026-09-03')
    makeTx(db, acct, big, 'BIG STORE', '2026-10-02')
    expect(items('S6').map((i) => i.text)).toEqual(expected)
  })
})

// --- S7 review backlog --------------------------------------------------------------------

describe('S7 review backlog', () => {
  it('S7 review backlog by count and by size', () => {
    const acct = account()
    for (let i = 0; i < 10; i++) makeTx(db, acct, '-5.00', `MYSTERY ${i}`, '2026-10-01')
    const found = items('S7')
    expect(found).toHaveLength(1)
    expect(found[0]?.text).toBe('10 transactions need review.')
    expect(found[0]?.href).toBe('/review')
  })

  it('S7 single large or quiet queue', () => {
    const acct = account()
    makeTx(db, acct, '-8.00', 'MYSTERY', '2026-10-01')
    expect(items('S7')).toEqual([])
    makeTx(db, acct, '-340.00', 'BIG MYSTERY', '2026-10-02')
    const found = items('S7')
    expect(found).toHaveLength(1)
    expect(found[0]?.text).toBe('2 transactions need review, including one for $340.')
  })

  it('a single large item', () => {
    makeTx(db, account(), '-150.00', 'BIG', '2026-10-01')
    expect(items('S7').map((i) => [i.text, i.key, i.amount])).toEqual([['A $150 transaction needs review.', 'S7:review:1:15000', null]])
  })
})

// --- S8 discretionary pace ----------------------------------------------------------------

describe('S8 discretionary pace', () => {
  it('S8 discretionary running above usual', () => {
    const acct = account()
    history(acct, '-300.00')
    coffee(acct, '-400.00', '2026-10-05')
    confident()
    const found = items('S8')
    expect(found).toHaveLength(1)
    expect(found[0]?.text).toBe('Discretionary spending is running 33% above usual.') // 400 vs 300
    expect(found[0]?.href).toBe('/spending?essentiality=discretionary&month=2026-10')
  })

  it('S8 on pace ignored', () => {
    const acct = account()
    history(acct, '-300.00')
    coffee(acct, '-350.00', '2026-10-05') // 17% above: under the 25% threshold
    confident()
    expect(items('S8')).toEqual([])
  })

  it.each([
    ['-200.00', '-253.00', ['Discretionary spending is running 26% above usual.']], // 26.5: to even
    ['-200.00', '-255.00', ['Discretionary spending is running 28% above usual.']], // 27.5: to even
    ['-300.00', '-375.00', []], // exactly 25%
    ['-300.00', '-375.01', ['Discretionary spending is running 25% above usual.']],
  ])('usual %s, now %s', (hist, now, expected) => {
    const acct = account()
    history(acct, hist)
    coffee(acct, now, '2026-10-05')
    confident()
    expect(items('S8').map((i) => i.text)).toEqual(expected)
  })
})

// --- S9 projection negative ---------------------------------------------------------------

function balance(acct: Account, amount: string): void {
  db.insert(balanceSnapshots).values({ account_id: acct.id, balance: parseMoney(amount), as_of: '2026-10-19T00:00:00.000Z' }).run()
}

describe('S9 projection negative', () => {
  it('S9 projection negative', () => {
    const acct = account()
    balance(acct, '-410.00')
    const found = items('S9')
    expect(found).toHaveLength(1)
    expect(found[0]?.text).toBe('Projected month-end balance is \u2212$410.')
    expect(found[0]?.href).toBe('/#balance')
    expect(found[0]?.amount).toBe('-410.00')
  })

  it('S9 positive projection ignored', () => {
    const acct = account()
    balance(acct, '5000.00')
    expect(items('S9')).toEqual([])
  })

  it('S9 projects from the day given to compute, not the real today', () => {
    // Real today is pinned to 2026-10-20; compute for 2026-11-02. A one-off planned payment
    // on 2026-11-10 falls in November's projection only (backlog item 24).
    const acct = account()
    balance(acct, '100.00')
    db.insert(manualEntries)
      .values({ amount: parseMoney('-500.00'), description: 'x', due_date: d('2026-11-10'), recurrence: 'none' })
      .run()
    const found = changes.compute(db, d('2026-11-02'), { includeAll: true }).items.filter((i) => i.signal === 'S9')
    expect(found.map((i) => [i.key, i.amount])).toEqual([['S9:projection:2026-11', '-400.00']])
  })
})

// --- dismissal, ordering, cap, determinism -------------------------------------------------

type Body = ChangesRead

describe('dismissal, ordering, cap, determinism', () => {
  it('dismiss hides until fact changes and clear restores', async () => {
    const acct = account('credit')
    recurrence(acct, 'NETFLIX.COM CA', '-15.49')
    makeTx(db, acct, '-22.99', 'NETFLIX.COM', '2026-10-03', { merchant_key: 'NETFLIX.COM CA' })
    const key = (items('S1')[0] as ChangeItem).key
    expect((await call('POST', '/api/reports/changes/dismiss', { key })).status).toBe(204)
    const signals = async () => ((await call('GET', '/api/reports/changes')).json as Body).items.map((i) => i.signal)
    expect(await signals()).not.toContain('S1')
    makeTx(db, acct, '-25.99', 'NETFLIX.COM', '2026-10-10', { merchant_key: 'NETFLIX.COM CA' })
    const back = items('S1')
    expect(back).toHaveLength(1)
    expect(back[0]?.key).not.toBe(key)
    expect(back[0]?.text).toContain('$25.99')
    expect((await call('DELETE', '/api/reports/changes/dismissals')).status).toBe(204)
    expect(db.select({ n: count() }).from(changeDismissals).get()?.n).toBe(0)
  })

  it('dismissing twice keeps one row, with the signal from the key', () => {
    changes.dismiss(db, 'S3:entry:1:2026-10-01')
    changes.dismiss(db, 'S3:entry:1:2026-10-01')
    changes.dismiss(db, 'NOCOLONSINTHISKEYATALL')
    expect(db.select({ key: changeDismissals.key, signal: changeDismissals.signal }).from(changeDismissals).all()).toEqual([
      { key: 'S3:entry:1:2026-10-01', signal: 'S3' },
      { key: 'NOCOLONSINTHISKEYATALL', signal: 'NOCOLONSIN' },
    ])
  })

  it('prune drops old dismissals', () => {
    const now = '2026-10-20T00:00:00.000Z'
    db.insert(changeDismissals)
      .values([
        { key: 'S3:entry:1:2026-06-01', signal: 'S3', dismissed_at: '2026-07-21T00:00:00.000Z' }, // 91 days
        { key: 'S3:entry:2:2026-10-01', signal: 'S3', dismissed_at: '2026-10-15T00:00:00.000Z' }, // 5 days
      ])
      .run()
    expect(changes.pruneDismissals(db, now)).toBe(1)
    expect(db.select({ key: changeDismissals.key }).from(changeDismissals).all().map((r) => r.key)).toEqual(['S3:entry:2:2026-10-01'])
  })

  it('prune keeps a dismissal exactly at the retention cutoff', () => {
    db.insert(changeDismissals).values({ key: 'S9:projection:2026-07', signal: 'S9', dismissed_at: '2026-07-22T00:00:00.000Z' }).run()
    expect(changes.pruneDismissals(db, '2026-10-20T00:00:00Z')).toBe(0)
    expect(changes.pruneDismissals(db, '2026-10-20T00:00:00.001Z')).toBe(1)
  })

  it('order by priority then impact and cap', async () => {
    const amounts = ['-100.00', '-900.00', '-500.00', '-50.00', '-60.00', '-70.00', '-80.00', '-90.00', '-95.00']
    amounts.forEach((amount, i) => entry(amount, '2026-10-01', { description: `Bill ${i}` }))
    const body = (await call('GET', '/api/reports/changes')).json as Body
    const s3 = body.items.filter((i) => i.signal === 'S3')
    expect(s3.slice(0, 3).map((i) => i.amount)).toEqual(['900.00', '500.00', '100.00'])
    expect(body.items).toHaveLength(7)
    expect(body.hidden).toBe(changes.compute(db, TODAY, { includeAll: true }).items.length - 7)
    const full = (await call('GET', '/api/reports/changes?all=true')).json as Body
    expect(full.hidden).toBe(0)
  })

  it('pins ties: equal impact keeps candidate order (S3 by entry id), and priority beats impact', () => {
    const acct = account()
    entry('-50.00', '2026-10-01', { description: 'First' })
    entry('-50.00', '2026-10-02', { description: 'Second' })
    entry('-50.00', '2026-10-03', { description: 'Third' })
    recurrence(acct, 'GYM', '-10.00', { next_expected_date: '2026-10-05', last_seen_on: '2026-09-05' })
    const result = changes.compute(db, TODAY, { includeAll: true })
    expect(result.items.map((i) => [i.signal, i.text.split(' ')[0]])).toEqual([
      ['S2', 'Gym'],
      ['S3', 'First'],
      ['S3', 'Second'],
      ['S3', 'Third'],
    ])
  })

  it('fixture list is deterministic', () => {
    loadSimplefinFixture(db)
    const first = changes.compute(db, TODAY, { includeAll: true })
    const second = changes.compute(db, TODAY, { includeAll: true })
    expect(first).toEqual(second)
    expect(first.items.every((i) => [...i.text].length < 120)).toBe(true)
    expect(first.items.every((i) => i.href.startsWith('/'))).toBe(true)
  })

  it('never calls an llm', () => {
    const refuse = () => {
      throw new Error('What changed must not call an LLM provider')
    }
    const spies = [FakeLLMProvider, ClaudeProvider, OllamaProvider].flatMap((cls) => [
      vi.spyOn(cls.prototype, 'classifyMerchants').mockImplementation(refuse),
      vi.spyOn(cls.prototype, 'suggestSavings').mockImplementation(refuse),
    ])
    loadSimplefinFixture(db)
    changes.compute(db, TODAY, { includeAll: true })
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    const source = readFileSync(fileURLToPath(new URL('../src/services/changes.ts', import.meta.url)), 'utf8')
    expect(source).not.toContain('providers/llm')
    expect(source).not.toContain('services/config')
  })
})

// --- formatting -----------------------------------------------------------------------------

describe('formatting (pinned values)', () => {
  it.each([
    [0, '$0.00'],
    [50, '$0.50'],
    [-500, '\u2212$5.00'],
    [9999, '$99.99'],
    [10000, '$100'],
    [10050, '$100'], // whole dollars round half to even
    [10150, '$102'],
    [123456, '$1,235'],
    [123456750, '$1,234,568'],
    [-41000, '\u2212$410'],
    [-1, '\u2212$0.01'],
    [-150050, '\u2212$1,500'],
  ])('money(%i) is %s', (value, text) => {
    expect(changes.money(cents(value))).toBe(text)
  })

  it('shortDate is the English month abbreviation and the unpadded day', () => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    months.forEach((name, i) => {
      const n = i + 1
      expect(changes.shortDate(d(`2026-${String(n).padStart(2, '0')}-${String(n).padStart(2, '0')}`))).toBe(`${name} ${n}`)
    })
  })

  it('the transactions href encodes like urlencode (quote_plus)', () => {
    expect(changes.transactionsHref(d('2026-10-01'), d('2026-11-01'), { q: "A&B c/d ~x!*'()\u00e9+%" })).toBe(
      '/transactions?q=A%26B+c%2Fd+~x%21%2A%27%28%29%C3%A9%2B%25&start=2026-10-01&end=2026-10-31',
    )
  })

  it('capwords splits on whitespace runs and capitalises each word', () => {
    expect(changes.capwords("  hello   wORLD\tfoo-bar o'neil ".toLowerCase())).toBe("Hello World Foo-bar O'neil")
  })

  // [input, capwords(lowered), capwords(input)] with Unicode 16 casing: capitalize title-cases
  // the first character and lowers the rest.
  it.each([
    ['\u00dftra\u00dfe x', 'Sstra\u00dfe X', 'Sstra\u00dfe X'],
    ['\u01c6emal \u01c4EMAL', '\u01c5emal \u01c5emal', '\u01c5emal \u01c5emal'],
    ['\u01c9ubljana \u01ccjegos \u01f3wonimir', '\u01c8ubljana \u01cbjegos \u01f2wonimir', '\u01c8ubljana \u01cbjegos \u01f2wonimir'],
    ['\ufb01sh \ufb00 \ufb06op', 'Fish Ff Stop', 'Fish Ff Stop'],
    ['\u10d0\u10d1 \u10fb', '\u10d0\u10d1 \u10fb', '\u10d0\u10d1 \u10fb'],
    ['\u1fb3x \u1f80y \u1fb2', '\u1fbcx \u1f88y \u1fba\u0345', '\u1fbcx \u1f88y \u1fba\u0345'],
    ['\u0587 \u0149x', '\u0535\u0582 \u02bcNx', '\u0535\u0582 \u02bcNx'],
    ['\u0391\u03a3 \u03a3\u0391 \u0391\u03a3\u0391', '\u0391\u03c2 \u03a3\u03b1 \u0391\u03c3\u03b1', '\u0391\u03c2 \u03a3\u03b1 \u0391\u03c3\u03b1'],
    ['\ua7cf\ua7ce \u{16ebb}\u{16ea0}', '\ua7cf\ua7ce \u{16ebb}\u{16ea0}', '\ua7cf\ua7ce \u{16ebb}\u{16ea0}'],
    ['\u0130stanbul', 'I\u0307stanbul', '\u0130stanbul'],
    ['\u0130I', 'I\u0307i', '\u0130i'],
  ])('capwords uses Unicode 16 title case on %j', (input, ofLowered, direct) => {
    expect(changes.capwords(changes.fullLower(input))).toBe(ofLowered)
    expect(changes.capwords(input)).toBe(direct)
  })

  // [input, lowered]: final sigma and Unicode 16 casing.
  it.each([
    ['\u0391\u03a3', '\u03b1\u03c2'],
    ['\u03a3', '\u03c3'],
    ['\u0391\u03a3\u0391', '\u03b1\u03c3\u03b1'],
    ["\u0391'\u03a3", "\u03b1'\u03c2"],
    ['\u0391\u03a3\u0301', '\u03b1\u03c2\u0301'],
    ['\u0391\u03a3\u0301\u0391', '\u03b1\u03c3\u0301\u03b1'],
    ['\u02b0\u03a3', '\u02b0\u03c3'],
    ['\ua7ce\u{16ea0}X', '\ua7ce\u{16ea0}x'],
    ['A\u03a3 \u03a3', 'a\u03c2 \u03c3'],
  ])('fullLower lowers with final sigma and Unicode 16 casing on %j', (input, lowered) => {
    expect(changes.fullLower(input)).toBe(lowered)
  })
})
