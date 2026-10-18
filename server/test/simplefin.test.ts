/**
 * The SimpleFIN adapter: claiming a setup token, fetching in 45-day chunks, request counting,
 * no retries, the pending rule, field normalisation, and the access URL never logged.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { type PlainDate, plainDate } from '../src/lib/dates.js'
import { ProviderError } from '../src/lib/errors.js'
import { formatMoney } from '../src/lib/money.js'
import {
  MAX_WINDOW_DAYS,
  SimpleFINProvider,
  chunkRanges,
  claimSetupToken,
  inferAccountType,
} from '../src/providers/bank/simplefin.js'
import { ACCESS_URL, type SimpleFINPayload, loadFixture, makeToken, mockFetch } from './factories.js'

const d = (text: string): PlainDate => plainDate(text)

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError)
    return error as ProviderError
  }
  throw new Error('expected a ProviderError')
}

describe('claimSetupToken', () => {
  it('exchanges the token for an access URL', async () => {
    const seen: Request[] = []
    const url = await claimSetupToken(makeToken(), mockFetch(() => new Response(`${ACCESS_URL}\n`), seen))
    expect(url).toBe(ACCESS_URL)
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.url).toBe('https://bridge.example/simplefin/claim/abc')
    expect(await seen[0]?.text()).toBe('')
  })

  it('rejects a bad token and a failed claim', async () => {
    await rejection(claimSetupToken('!!!not base64!!!', mockFetch()))
    await rejection(claimSetupToken(Buffer.from('not a url').toString('base64'), mockFetch()))
    const denied = mockFetch(() => new Response(null, { status: 403 }))
    const error = await rejection(claimSetupToken(makeToken(), denied))
    expect(error.detail).toMatch(/403/)
  })

  it('explains a bad setup token in plain words', async () => {
    expect((await rejection(claimSetupToken('!!!not base64!!!', mockFetch()))).detail).toBe(
      'The SimpleFIN setup token is not valid base64.',
    )
    expect((await rejection(claimSetupToken(Buffer.from('not a url').toString('base64'), mockFetch()))).detail).toBe(
      'The SimpleFIN setup token does not contain a claim URL.',
    )
    expect((await rejection(claimSetupToken(makeToken(), mockFetch(() => new Response(null, { status: 403 }))))).detail).toBe(
      'SimpleFIN rejected the setup token (HTTP 403). A token can be claimed only once; create a new one.',
    )
    const garbage = mockFetch(() => new Response('ftp://elsewhere'))
    expect((await rejection(claimSetupToken(makeToken(), garbage))).detail).toBe(
      'SimpleFIN returned an unexpected access URL.',
    )
    const down = mockFetch(() => {
      throw new TypeError('fetch failed')
    })
    expect((await rejection(claimSetupToken(makeToken(), down))).detail).toBe(
      'Could not reach SimpleFIN to claim the setup token.',
    )
  })

  it('accepts URL-safe base64, missing padding, and surrounding whitespace', async () => {
    // "~~~" encodes as "fn5+": standard base64 needs "+", URL-safe base64 uses "-".
    const claim = 'https://bridge.example/simplefin/claim/~~~'
    const standard = Buffer.from(claim).toString('base64')
    expect(standard).toMatch(/[+/]/)
    const urlsafe = standard.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    for (const token of [standard, urlsafe, `  ${urlsafe}\n`]) {
      const seen: Request[] = []
      await claimSetupToken(token, mockFetch(() => new Response(ACCESS_URL), seen))
      expect(seen[0]?.url).toBe(claim)
    }
    const unpadded = makeToken('https://bridge.example/simplefin/claim/ab').replace(/=+$/, '')
    expect(unpadded.length % 4).not.toBe(0)
    const seen: Request[] = []
    await claimSetupToken(unpadded, mockFetch(() => new Response(ACCESS_URL), seen))
    expect(seen[0]?.url).toBe('https://bridge.example/simplefin/claim/ab')
  })

  it('rejects a token that does not decode to UTF-8 or has impossible padding', async () => {
    await rejection(claimSetupToken(Buffer.from([0xff, 0xfe, 0xfd]).toString('base64'), mockFetch()))
    await rejection(claimSetupToken('abcde', mockFetch()))
    await rejection(claimSetupToken('tök', mockFetch()))
  })

  it('does not follow redirects', async () => {
    const seen: Request[] = []
    await claimSetupToken(makeToken(), mockFetch(() => new Response(ACCESS_URL), seen))
    expect(seen[0]?.redirect).toBe('manual')
  })
})

describe('SimpleFINProvider.fetch', () => {
  it('parses the fixture including pending', async () => {
    const requests: Request[] = []
    const provider = new SimpleFINProvider(ACCESS_URL, mockFetch(undefined, requests))
    const snap = await provider.fetch(d('2026-09-01'), d('2026-10-03'))
    expect(requests).toHaveLength(1)
    const req = requests[0] as Request
    const url = new URL(req.url)
    expect(url.host).toBe('bridge.example')
    expect(url.pathname).toBe('/simplefin/accounts')
    expect(req.url).not.toContain('user123')
    expect(req.headers.get('authorization')?.startsWith('Basic ')).toBe(true)
    expect(url.searchParams.get('pending')).toBe('1')
    expect(url.searchParams.has('start-date')).toBe(true)
    expect(url.searchParams.has('end-date')).toBe(true)

    const byName = new Map(snap.accounts.map((a) => [a.name, a]))
    expect(new Set(byName.keys())).toEqual(new Set(['Everyday Checking', 'Rewards Visa', 'High Yield Savings']))
    const visa = byName.get('Rewards Visa')
    expect(visa?.type).toBe('credit')
    expect(byName.get('High Yield Savings')?.type).toBe('savings')
    expect(byName.get('Everyday Checking')?.type).toBe('checking')
    expect(visa?.institution_name).toBe('Example Card Co')
    expect(formatMoney(visa?.balance as never)).toBe('-842.17')
    expect(formatMoney(visa?.available as never)).toBe('7157.83')
    expect(snap.errors).toEqual([])
    const pending = snap.accounts.flatMap((a) => a.transactions).filter((t) => t.pending)
    expect(pending.map((t) => t.external_id)).toEqual(['TRN-100294'])
    expect(pending[0]?.posted_on).toBe(pending[0]?.transacted_at?.slice(0, 10))
    const first = byName.get('Everyday Checking')?.transactions[0]
    expect(first?.payee).toBe('Acme Corp')
    expect(first?.memo).toBeNull() // empty string normalized
  })

  it('chunks long windows and merges', async () => {
    const requests: Request[] = []
    const provider = new SimpleFINProvider(ACCESS_URL, mockFetch(undefined, requests))
    const snap = await provider.fetch(d('2026-01-01'), d('2026-07-01')) // 182 days -> 5 chunks of <=45
    expect(requests).toHaveLength(5)
    for (const r of requests) {
      const params = new URL(r.url).searchParams
      const span = Number(params.get('end-date')) - Number(params.get('start-date'))
      expect(span).toBeLessThanOrEqual(45 * 86400)
    }
    expect(snap.accounts).toHaveLength(3) // merged, not tripled
    expect(snap.accounts.reduce((n, a) => n + a.transactions.length, 0)).toBe(295) // deduplicated
  })

  it('surfaces provider errors', async () => {
    const payload = loadFixture()
    payload.errors = ['Connection to Example Bank may need attention']
    const snap = await new SimpleFINProvider(ACCESS_URL, mockFetch(payload)).fetch(d('2026-09-01'), d('2026-10-03'))
    expect(snap.errors).toEqual(['Connection to Example Bank may need attention'])
  })

  it('raises ProviderError on HTTP failure', async () => {
    const provider = new SimpleFINProvider(ACCESS_URL, mockFetch(() => new Response(null, { status: 402 })))
    const error = await rejection(provider.fetch(d('2026-09-01'), d('2026-10-03')))
    expect(error.detail).toMatch(/402/)
    expect(error.detail).toBe('SimpleFIN returned HTTP 402.')
  })
})

describe('inferAccountType', () => {
  it.each([
    ['Chase Sapphire Credit Card', 'credit'],
    ['Amex Gold', 'credit'],
    ['Online Savings', 'savings'],
    ['Total Checking', 'checking'],
    ['Brokerage', 'other'],
  ] as const)('%s is %s', (name, expected) => {
    expect(inferAccountType(name)).toBe(expected)
  })

  it('checks credit words before savings and checking', () => {
    expect(inferAccountType('Savings Visa')).toBe('credit')
    expect(inferAccountType('Checking and Savings')).toBe('savings')
    expect(inferAccountType('MASTERCARD')).toBe('credit')
    expect(inferAccountType('')).toBe('other')
  })
})

describe('chunkRanges', () => {
  it('splits into inclusive, non-overlapping ranges of at most 45 days', () => {
    expect(MAX_WINDOW_DAYS).toBe(45)
    expect(chunkRanges(d('2026-01-01'), d('2026-07-01'))).toEqual([
      ['2026-01-01', '2026-02-14'],
      ['2026-02-15', '2026-03-31'],
      ['2026-04-01', '2026-05-15'],
      ['2026-05-16', '2026-06-29'],
      ['2026-06-30', '2026-07-01'],
    ])
    expect(chunkRanges(d('2026-01-01'), d('2026-02-14'))).toEqual([['2026-01-01', '2026-02-14']])
    expect(chunkRanges(d('2026-03-05'), d('2026-03-05'))).toEqual([['2026-03-05', '2026-03-05']])
    expect(chunkRanges(d('2026-03-06'), d('2026-03-05'))).toEqual([])
  })
})

describe('requests', () => {
  it('sends midnight-UTC bounds with the end date exclusive, then pending', async () => {
    const requests: Request[] = []
    await new SimpleFINProvider(ACCESS_URL, mockFetch(undefined, requests)).fetch(d('2026-09-01'), d('2026-10-03'))
    const url = new URL((requests[0] as Request).url)
    expect([...url.searchParams.keys()]).toEqual(['start-date', 'end-date', 'pending'])
    expect(url.searchParams.get('start-date')).toBe(String(Date.UTC(2026, 8, 1) / 1000))
    expect(url.searchParams.get('end-date')).toBe(String(Date.UTC(2026, 9, 4) / 1000))
    expect(url.search).toBe(`?start-date=${Date.UTC(2026, 8, 1) / 1000}&end-date=${Date.UTC(2026, 9, 4) / 1000}&pending=1`)
  })

  it('authenticates with the URL credentials as basic auth', async () => {
    const requests: Request[] = []
    await new SimpleFINProvider(ACCESS_URL, mockFetch(undefined, requests)).fetch(d('2026-09-01'), d('2026-09-02'))
    const header = (requests[0] as Request).headers.get('authorization')
    expect(header).toBe(`Basic ${Buffer.from('user123:pass456').toString('base64')}`)
    expect((requests[0] as Request).url).toBe(
      `https://bridge.example/simplefin/accounts?start-date=${Date.UTC(2026, 8, 1) / 1000}&end-date=${Date.UTC(2026, 8, 3) / 1000}&pending=1`,
    )
  })

  it('keeps an explicit port and drops a trailing slash, query, and fragment', async () => {
    const requests: Request[] = []
    const provider = new SimpleFINProvider('https://u:p@Bridge.Example:8443/simplefin/?x=1#frag', mockFetch(undefined, requests))
    await provider.fetch(d('2026-09-01'), d('2026-09-01'))
    expect((requests[0] as Request).url.split('?')[0]).toBe('https://bridge.example:8443/simplefin/accounts')
  })

  it('counts one request per chunk', async () => {
    const provider = new SimpleFINProvider(ACCESS_URL, mockFetch())
    expect(provider.requestsMade).toBe(0)
    await provider.fetch(d('2026-01-01'), d('2026-07-01'))
    expect(provider.requestsMade).toBe(5)
    await provider.fetch(d('2026-09-01'), d('2026-10-03'))
    expect(provider.requestsMade).toBe(6)
  })

  it('makes no request for an empty window', async () => {
    const requests: Request[] = []
    const provider = new SimpleFINProvider(ACCESS_URL, mockFetch(undefined, requests))
    expect(await provider.fetch(d('2026-03-06'), d('2026-03-05'))).toEqual({ accounts: [], errors: [] })
    expect(requests).toHaveLength(0)
    expect(provider.requestsMade).toBe(0)
  })

  it('never retries, and counts failed requests', async () => {
    const requests: Request[] = []
    const provider = new SimpleFINProvider(ACCESS_URL, mockFetch(() => new Response('oops', { status: 500 }), requests))
    await rejection(provider.fetch(d('2026-01-01'), d('2026-07-01')))
    expect(requests).toHaveLength(1)
    expect(provider.requestsMade).toBe(1)

    const down = new SimpleFINProvider(
      ACCESS_URL,
      mockFetch(() => {
        throw new TypeError('fetch failed')
      }),
    )
    expect((await rejection(down.fetch(d('2026-09-01'), d('2026-10-03')))).detail).toBe(
      'Could not reach SimpleFIN: ConnectError',
    )
    expect(down.requestsMade).toBe(1)
  })

  it('reports a timeout as ReadTimeout', async () => {
    const slow = new SimpleFINProvider(
      ACCESS_URL,
      mockFetch(() => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      }),
    )
    expect((await rejection(slow.fetch(d('2026-09-01'), d('2026-10-03')))).detail).toBe(
      'Could not reach SimpleFIN: ReadTimeout',
    )
  })

  it('does not follow redirects', async () => {
    const requests: Request[] = []
    await new SimpleFINProvider(ACCESS_URL, mockFetch(undefined, requests)).fetch(d('2026-09-01'), d('2026-09-01'))
    expect((requests[0] as Request).redirect).toBe('manual')
    const moved = mockFetch(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }))
    expect((await rejection(new SimpleFINProvider(ACCESS_URL, moved).fetch(d('2026-09-01'), d('2026-09-01')))).detail).toBe(
      'SimpleFIN returned HTTP 302.',
    )
  })

  it('rejects a response that is not JSON or not an object', async () => {
    const notJson = new SimpleFINProvider(ACCESS_URL, mockFetch(() => new Response('<html>')))
    expect((await rejection(notJson.fetch(d('2026-09-01'), d('2026-09-01')))).detail).toBe(
      'SimpleFIN returned a response that is not JSON.',
    )
    const list = new SimpleFINProvider(ACCESS_URL, mockFetch(() => Response.json([1, 2])))
    expect((await rejection(list.fetch(d('2026-09-01'), d('2026-09-01')))).detail).toBe(
      'SimpleFIN returned an unexpected response shape.',
    )
  })
})

function account(transactions: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ACT-1',
    name: 'Joint Checking',
    currency: 'usd',
    balance: '100.00',
    'available-balance': '90.00',
    'balance-date': 1790769600,
    org: { name: 'Example Bank', domain: 'examplebank.example' },
    transactions,
    ...extra,
  }
}

async function fetchOne(payload: Record<string, unknown>, start = '2026-09-01', end = '2026-10-03') {
  const snap = await new SimpleFINProvider(ACCESS_URL, mockFetch(payload)).fetch(d(start), d(end))
  return snap
}

describe('parsing', () => {
  it('applies the pending rule', async () => {
    const snap = await fetchOne({
      errors: [],
      accounts: [
        account([
          // No posting date: pending, dated when it happened.
          { id: 'T1', posted: 0, amount: '-1.00', transacted_at: 1790769600, pending: false },
          // No posting date and no transaction time: pending, dated the window end.
          { id: 'T2', posted: 0, amount: '-2.00' },
          // Posted but flagged pending: pending, dated the posting day (UTC).
          { id: 'T3', posted: 1790812799, amount: '-3.00', pending: true },
          // Posted, not pending.
          { id: 'T4', posted: 1790812800, amount: '-4.00', transacted_at: 1790769600 },
        ]),
      ],
    })
    const [t1, t2, t3, t4] = snap.accounts[0]?.transactions ?? []
    expect(t1).toMatchObject({ pending: true, posted_on: '2026-09-30', transacted_at: '2026-09-30T12:00:00.000Z' })
    expect(t2).toMatchObject({ pending: true, posted_on: '2026-10-03', transacted_at: null })
    expect(t3).toMatchObject({ pending: true, posted_on: '2026-09-30', transacted_at: null })
    expect(t4).toMatchObject({ pending: false, posted_on: '2026-10-01', transacted_at: '2026-09-30T12:00:00.000Z' })
  })

  it('dates a pending transaction with no time at the end of its chunk', async () => {
    const snap = await fetchOne({ accounts: [account([{ id: 'T2', amount: '-2.00' }])] }, '2026-01-01', '2026-03-01')
    expect(snap.accounts[0]?.transactions[0]?.posted_on).toBe('2026-03-01')
    const requests: Request[] = []
    const chunked = await new SimpleFINProvider(
      ACCESS_URL,
      mockFetch((request) => {
        requests.push(request)
        // Only the first chunk reports the transaction.
        return Response.json({ accounts: [account(requests.length === 1 ? [{ id: 'T2', amount: '-2.00' }] : [])] })
      }),
    ).fetch(d('2026-01-01'), d('2026-03-01'))
    expect(chunked.accounts[0]?.transactions[0]?.posted_on).toBe('2026-02-14')
  })

  it('normalises account fields', async () => {
    const snap = await fetchOne({
      accounts: [
        account([], { currency: 'usdollars', 'available-balance': '' }),
        account([], { id: 'ACT-2', name: '', currency: null, org: { domain: 'bank.example' }, 'available-balance': null }),
        account([], { id: 'ACT-3', org: null, balance: '12.345', 'balance-date': 0 }),
      ],
    })
    const [a, b, c] = snap.accounts
    expect(a).toMatchObject({ currency: 'USD', available: null, institution_name: 'Example Bank', balance: 10000 })
    expect(a?.balance_as_of).toBe('2026-09-30T12:00:00.000Z')
    expect(b).toMatchObject({ name: 'ACT-2', type: 'other', currency: 'USD', institution_name: 'bank.example', available: null })
    expect(c?.institution_name).toBeNull()
    // Extra places round half away from zero (stored amounts' rule).
    expect(c?.balance).toBe(1235)
    expect(Date.parse(c?.balance_as_of ?? '')).toBeGreaterThan(Date.UTC(2026, 0, 1))
  })

  it('normalises transaction fields', async () => {
    const snap = await fetchOne({
      accounts: [
        account([
          { id: 'T1', posted: 1790769600, amount: '-5.5', description: null, payee: '', memo: 'note' },
          { id: 'T2', posted: 1790769600, amount: 12.25, description: 'X', payee: 'Shop' },
          { id: 'T3', posted: 1790769600 },
        ]),
      ],
    })
    const [t1, t2, t3] = snap.accounts[0]?.transactions ?? []
    expect(t1).toMatchObject({ amount: -550, description: '', payee: null, memo: 'note' })
    expect(t2).toMatchObject({ amount: 1225, description: 'X', payee: 'Shop', memo: null })
    expect(t3).toMatchObject({ amount: 0, description: '', pending: false })
  })

  it('rejects a non-numeric amount, quoting the value', async () => {
    const bad = fetchOne({ accounts: [account([{ id: 'T1', posted: 1790769600, amount: 'abc' }])] })
    expect((await rejection(bad)).detail).toBe("SimpleFIN returned a non-numeric amount: 'abc'")
    const missing = fetchOne({ accounts: [account([{ id: 'T1', posted: 1790769600, amount: null }])] })
    expect((await rejection(missing)).detail).toBe('SimpleFIN returned a non-numeric amount: None')
  })

  it('merges chunks: newest balance wins, transactions deduplicated in first-seen order', async () => {
    let call = 0
    const fetchFn = mockFetch(() => {
      call += 1
      if (call === 1) {
        return Response.json({
          errors: ['stale', 'again'],
          accounts: [
            account([
              { id: 'T1', posted: 1767312000, amount: '-1.00', description: 'old' },
              { id: 'T2', posted: 1767312000, amount: '-2.00' },
            ], { balance: '1.00', 'balance-date': 1767312000 }),
          ],
        })
      }
      return Response.json({
        errors: ['again', 'new'],
        accounts: [
          account([
            { id: 'T3', posted: 1771286400, amount: '-3.00' },
            { id: 'T1', posted: 1767312000, amount: '-1.00', description: 'updated' },
          ], { balance: '2.00', 'balance-date': 1771286400 }),
        ],
      })
    })
    const snap = await new SimpleFINProvider(ACCESS_URL, fetchFn).fetch(d('2026-01-01'), d('2026-03-01'))
    expect(snap.errors).toEqual(['stale', 'again', 'new'])
    expect(snap.accounts).toHaveLength(1)
    expect(snap.accounts[0]?.balance).toBe(200)
    expect(snap.accounts[0]?.transactions.map((t) => [t.external_id, t.description])).toEqual([
      ['T1', 'updated'],
      ['T2', ''],
      ['T3', ''],
    ])
  })

  it('keeps the earlier balance when a later chunk reports an older one', async () => {
    let call = 0
    const fetchFn = mockFetch(() => {
      call += 1
      const stamp = call === 1 ? 1771286400 : 1767312000
      return Response.json({ accounts: [account([], { balance: `${call}.00`, 'balance-date': stamp })] })
    })
    const snap = await new SimpleFINProvider(ACCESS_URL, fetchFn).fetch(d('2026-01-01'), d('2026-03-01'))
    expect(snap.accounts[0]?.balance).toBe(100)
  })
})

describe('privacy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never logs the access URL or its credentials', async () => {
    const written: string[] = []
    const capture = (...args: unknown[]) => {
      written.push(args.map(String).join(' '))
      return true
    }
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, method).mockImplementation(capture)
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(capture)
    vi.spyOn(process.stderr, 'write').mockImplementation(capture)

    const messages: string[] = []
    const payload: SimpleFINPayload = loadFixture()
    await new SimpleFINProvider(ACCESS_URL, mockFetch(payload)).fetch(d('2026-01-01'), d('2026-07-01'))
    const failures = [
      () => new Response(null, { status: 401 }),
      () => new Response('not json'),
      () => {
        throw new TypeError(`fetch failed for ${ACCESS_URL}`)
      },
    ]
    for (const handler of failures) {
      const error = await rejection(new SimpleFINProvider(ACCESS_URL, mockFetch(handler)).fetch(d('2026-09-01'), d('2026-09-02')))
      messages.push(error.message, error.detail, String(error.stack))
    }
    const claimed = mockFetch(() => new Response(null, { status: 403 }))
    const error = await rejection(claimSetupToken(makeToken(ACCESS_URL), claimed))
    messages.push(error.message, String(error.stack))
    vi.restoreAllMocks()

    for (const text of [...written, ...messages]) {
      expect(text).not.toContain('pass456')
      expect(text).not.toContain('user123')
    }
  })
})
