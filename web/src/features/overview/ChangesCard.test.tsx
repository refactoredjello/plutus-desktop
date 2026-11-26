import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { setAverageMonths } from '@/mocks/changes'
import { server } from '@/mocks/server'
import { toasts } from '@/test/motion'
import { renderAt } from '@/test/render'

const sentence = (re: RegExp) => screen.findByRole('link', { name: re })

async function target(re: RegExp) {
  const a = await sentence(re)
  const url = new URL(a.getAttribute('href')!, 'http://x')
  return { path: url.pathname, params: Object.fromEntries(url.searchParams), hash: url.hash }
}

describe('ChangesCard links', () => {
  it('S1 and S2 link to /recurring, S3 to /planned, S7 to /review', async () => {
    renderAt('/')
    expect((await target(/Netflix went from/)).path).toBe('/recurring')
    expect((await target(/Gym membership/)).path).toBe('/recurring')
    expect((await target(/Car insurance/)).path).toBe('/planned')
    expect((await target(/need a category/)).path).toBe('/review')
  })

  it('S4 links to transactions by category and month', async () => {
    renderAt('/')
    const t = await target(/Restaurants is/)
    expect(t.path).toBe('/transactions')
    expect(t.params).toEqual({ category: '17', start: '2026-10-01', end: '2026-10-31' })
  })

  it('S5 links to transactions by merchant and month', async () => {
    renderAt('/')
    const t = await target(/First purchase at Home Depot/)
    expect(t.path).toBe('/transactions')
    expect(t.params).toEqual({ q: 'Home Depot', start: '2026-10-01', end: '2026-10-31' })
  })

  it('S6 links to transactions by description and month', async () => {
    renderAt('/')
    const t = await target(/Delta Air Lines/)
    expect(t.path).toBe('/transactions')
    expect(t.params).toEqual({ q: 'DELTA AIR LINES', start: '2026-10-01', end: '2026-10-31' })
  })

  it('S8 links to the discretionary spending breakdown', async () => {
    renderAt('/')
    // S8 and S9 sit beyond the cap of seven; expand first.
    await userEvent.setup().click(await screen.findByRole('button', { name: '2 more' }))
    const t = await target(/Discretionary spending/)
    expect(t.path).toBe('/spending')
    expect(t.params).toEqual({ essentiality: 'discretionary', month: '2026-10' })
  })

  it('S9 links to #balance and the balance card has that id', async () => {
    renderAt('/')
    await userEvent.setup().click(await screen.findByRole('button', { name: '2 more' }))
    const t = await target(/Projected month-end balance is/)
    expect(t.path).toBe('/')
    expect(t.hash).toBe('#balance')
    await waitFor(() => expect(document.getElementById('balance')).toBeInTheDocument())
  })
})

describe('ChangesCard behaviour', () => {
  it('emphasises the amount for S1, S2, S3 and S9 only', async () => {
    renderAt('/')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '2 more' }))
    const amountOf = async (re: RegExp) => within(await sentence(re)).queryByTestId('change-amount')
    expect(await amountOf(/Netflix/)).toHaveTextContent('$22.99') // the new price, not the old one
    expect(await amountOf(/Car insurance/)).toHaveTextContent('$412')
    expect(await amountOf(/Projected month-end/)).toHaveTextContent('−$410')
    expect(await amountOf(/Gym membership/)).toBeNull() // no amount in the sentence
    expect(await amountOf(/Restaurants is/)).toBeNull()
    expect(await amountOf(/Home Depot/)).toBeNull()
    expect(await amountOf(/Delta Air Lines/)).toBeNull()
  })

  it('dismiss removes the item and posts the key', async () => {
    let body: unknown
    server.use(
      http.post('/api/reports/changes/dismiss', async ({ request }) => {
        body = await request.clone().json()
        return undefined
      }),
    )
    renderAt('/')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /^Dismiss: Netflix went from/ }))
    await waitFor(() => expect(screen.queryByRole('link', { name: /Netflix went from/ })).toBeNull())
    expect(body).toEqual({ key: 'S1:recurrence:1:2299' })
  })

  it('restores the row and toasts when dismiss fails', async () => {
    server.use(http.post('/api/reports/changes/dismiss', () => new HttpResponse(null, { status: 500 })))
    renderAt('/')
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Dismiss: Netflix went from/ }))
    expect(await toasts().findByText('Could not dismiss that change')).toBeInTheDocument()
    expect(await sentence(/Netflix went from/)).toBeInTheDocument()
  })

  it('"N more" expands in place by fetching all=true', async () => {
    const seen: (string | null)[] = []
    server.use(
      http.get('/api/reports/changes', ({ request }) => {
        seen.push(new URL(request.url).searchParams.get('all'))
        return undefined
      }),
    )
    renderAt('/')
    expect(screen.queryByText(/Discretionary spending/)).toBeNull()
    await userEvent.setup().click(await screen.findByRole('button', { name: '2 more' }))
    expect(await sentence(/Discretionary spending/)).toBeInTheDocument()
    expect(seen).toContain('true')
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
  })

  it('shows the empty line', async () => {
    server.use(
      http.get('/api/reports/changes', () =>
        HttpResponse.json({ as_of: '2026-10-04', average_months: 3, items: [], hidden: 0 }),
      ),
    )
    renderAt('/')
    expect(await screen.findByText('Nothing unusual this month.')).toBeInTheDocument()
  })

  it('describes the comparison window', async () => {
    renderAt('/')
    expect(await screen.findByText('Compared with your usual three months.')).toBeInTheDocument()
  })

  it('falls back to "average so far" with fewer than three months', async () => {
    setAverageMonths(1)
    renderAt('/')
    expect(await screen.findByText('Compared with your average so far.')).toBeInTheDocument()
  })

  it('shows an error with retry while the rest of Overview renders', async () => {
    let fail = true
    server.use(
      http.get('/api/reports/changes', () =>
        fail
          ? HttpResponse.json({ title: 'Error', status: 500 }, { status: 500 })
          : HttpResponse.json({ as_of: '2026-10-04', average_months: 3, items: [], hidden: 0 }),
      ),
    )
    renderAt('/')
    expect(await screen.findByText('Couldn’t load what changed.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(await screen.findByText('Income so far')).toBeInTheDocument()
    fail = false
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Nothing unusual this month.')).toBeInTheDocument()
  })
})

describe('ChangesCard signal markers', () => {
  it('leads every line with a marker for its signal, inside the link', async () => {
    renderAt('/')
    const link = await sentence(/Netflix went from/)
    expect(link.querySelector('[data-signal="S1"]')).not.toBeNull()
    expect((await sentence(/Gym membership/)).querySelector('[data-signal="S2"]')).not.toBeNull()
    expect((await sentence(/First purchase at Home Depot/)).querySelector('[data-signal="S5"]')).not.toBeNull()
    expect((await sentence(/need a category/)).querySelector('[data-signal="S7"]')).not.toBeNull()
    // The dismiss control stays beside the link.
    expect(screen.getByRole('button', { name: /Dismiss: Netflix went from/ })).toBeInTheDocument()
  })

  it('colours a missed bill as a warning and a first-time merchant quietly', async () => {
    renderAt('/')
    const missed = (await sentence(/Gym membership/)).querySelector('[data-signal="S2"]')!
    expect(missed.getAttribute('class')).toMatch(/destructive/)
    const first = (await sentence(/First purchase at Home Depot/)).querySelector('[data-signal="S5"]')!
    expect(first.getAttribute('class')).toMatch(/muted-foreground/)
  })
})
