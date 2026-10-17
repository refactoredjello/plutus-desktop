import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { addMonths, monthEnd, monthKey } from '@/lib/dates'
import { server } from '@/mocks/server'
import { renderAt } from '@/test/render'

const month = monthKey(new Date())

function recordByCategory() {
  const urls: URL[] = []
  server.use(
    http.get('/api/reports/by-category', ({ request}) => {
      urls.push(new URL(request.url))
      return undefined
    }),
  )
  return urls
}

describe('Overview essentiality links', () => {
  it('links each bucket for the latest month to the breakdown', async () => {
    const user = userEvent.setup()
    renderAt('/')
    await user.click(await screen.findByRole('link', { name: 'Flexible' }))
    expect(await screen.findByRole('heading', { name: 'Spending breakdown' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Flexible' })).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByRole('link', { name: /Restaurant/ })).toBeInTheDocument()
  })

  it('links to the not-set breakdown', async () => {
    renderAt('/')
    expect(await screen.findByRole('link', { name: 'Not set' })).toHaveAttribute(
      'href',
      `/spending?essentiality=unset&month=${month}`,
    )
  })
})

describe('Spending breakdown', () => {
  it('defaults to discretionary this month and requests that bucket', async () => {
    const urls = recordByCategory()
    renderAt('/spending')
    expect(await screen.findByRole('link', { name: /Coffee/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discretionary' })).toHaveAttribute('aria-pressed', 'true')
    const p = urls.at(-1)!.searchParams
    expect(p.get('essentiality')).toBe('discretionary')
    expect(p.get('month')).toBe(month)
    expect(screen.queryByRole('link', { name: /Rent/ })).not.toBeInTheDocument()
  })

  it('shows amount, share and count on each row', async () => {
    renderAt('/spending?essentiality=discretionary')
    const row = await screen.findByRole('link', { name: /Coffee/ })
    expect(row).toHaveTextContent(/\d+% · 18 transactions/)
    expect(await screen.findByText(/Discretionary in /)).toBeInTheDocument()
  })

  it('switches bucket', async () => {
    const urls = recordByCategory()
    const user = userEvent.setup()
    renderAt('/spending?essentiality=discretionary')
    await screen.findByRole('link', { name: /Coffee/ })
    await user.click(screen.getByRole('button', { name: 'Essential' }))
    expect(await screen.findByRole('link', { name: /Rent/ })).toBeInTheDocument()
    await waitFor(() => expect(urls.at(-1)!.searchParams.get('essentiality')).toBe('essential'))
  })

  it('switches month', async () => {
    const urls = recordByCategory()
    const user = userEvent.setup()
    renderAt('/spending?essentiality=essential')
    await screen.findByRole('link', { name: /Rent/ })
    await user.click(screen.getByRole('combobox', { name: 'Month' }))
    const prev = addMonths(month, -1)
    const label = new Date(Number(prev.slice(0, 4)), Number(prev.slice(5)) - 1, 1).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
    })
    await user.click(await screen.findByRole('option', { name: label }))
    await waitFor(() => expect(urls.at(-1)!.searchParams.get('month')).toBe(prev))
  })

  it('links a category row to filtered transactions', async () => {
    renderAt('/spending?essentiality=essential')
    const link = await screen.findByRole('link', { name: /Groceries/ })
    expect(link).toHaveAttribute(
      'href',
      `/transactions?category=7&essentiality=essential&start=${month}-01&end=${monthEnd(month)}`,
    )
  })

  it('links the Uncategorized row to the no-category filter', async () => {
    const user = userEvent.setup()
    renderAt('/spending?essentiality=unset')
    const link = await screen.findByRole('link', { name: /Uncategorized/ })
    expect(link).toHaveAttribute('href', `/transactions?uncategorized=1&start=${month}-01&end=${monthEnd(month)}`)
    await user.click(link)
    expect(await screen.findByRole('combobox', { name: 'Category filter' })).toHaveTextContent('No category')
  })

  it('shows an empty state', async () => {
    server.use(http.get('/api/reports/by-category', () => HttpResponse.json([])))
    renderAt('/spending?essentiality=essential&month=2026-03')
    expect(await screen.findByText('No spending in this bucket for March 2026')).toBeInTheDocument()
  })

  it('shows an error state with retry', { timeout: 8000 }, async () => {
    server.use(
      http.get('/api/reports/by-category', () =>
        HttpResponse.json({ title: 'Error', status: 500, detail: 'Database unavailable' }, { status: 500 }),
      ),
    )
    renderAt('/spending')
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent('Database unavailable')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('links back to the overview', async () => {
    const user = userEvent.setup()
    renderAt('/spending')
    await user.click(screen.getByRole('link', { name: 'Back to overview' }))
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument()
  })
})
