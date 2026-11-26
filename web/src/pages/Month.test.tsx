import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '@/api/client'
import { addMonths, monthEnd, monthKey, monthLabel } from '@/lib/dates'
import { monthDetail } from '@/mocks/month'
import { server } from '@/mocks/server'
import { renderAt } from '@/test/render'

const current = monthKey(new Date())
const prev = addMonths(current, -1)
const cardTitle = (name: string) =>
  [...document.querySelectorAll('[data-slot="card-title"]')].find((e) => e.textContent === name) as HTMLElement | undefined
const tile = (label: string) => within(screen.getByRole('region', { name: 'Month totals' })).getByText(label).closest('[data-slot="card"]') as HTMLElement

function serve(over: Partial<Schemas['MonthDetail']>) {
  server.use(http.get('/api/reports/month/:month', ({ params }) => HttpResponse.json({ ...monthDetail(String(params.month)), ...over })))
}

describe('Month view', () => {
  it('shows a complete month with arrows and a review link', async () => {
    renderAt(`/month/${prev}`)
    expect(await screen.findByRole('heading', { name: monthLabel(prev, 'long') })).toBeInTheDocument()
    expect(await screen.findByText('Complete month')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Previous month' })).toHaveAttribute('href', `/month/${addMonths(prev, -1)}`)
    expect(screen.getByRole('link', { name: 'Next month' })).toHaveAttribute('href', `/month/${current}`)
    expect(screen.getByRole('link', { name: '3 to review' })).toHaveAttribute('href', '/review')
  })

  it('/month shows the current month in progress, with no next arrow and no coloured comparison', async () => {
    renderAt('/month')
    expect(await screen.findByRole('heading', { name: monthLabel(current, 'long') })).toBeInTheDocument()
    expect(await screen.findByText(/^In progress, day \d+ of \d+$/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Next month' })).toBeNull()
    const spending = tile('Spending so far')
    expect(within(spending).getByText(/^3-mo avg /)).toBeInTheDocument()
    expect(spending.querySelector('.text-destructive')).toBeNull()
  })

  it('colours spending against the average, and stays neutral within 5%', async () => {
    serve({ expenses: '6000.00', expenses_average: '5000.00' })
    renderAt(`/month/${prev}`)
    const above = await screen.findByText('$1,000.00 above 3-mo avg')
    expect(above).toHaveClass('text-destructive')
  })

  it('colours spending below average as success', async () => {
    serve({ expenses: '4000.00', expenses_average: '5000.00' })
    renderAt(`/month/${prev}`)
    expect(await screen.findByText('$1,000.00 below 3-mo avg')).toHaveClass('text-emerald-700')
  })

  it('shows "about the same as usual" within 5%', async () => {
    serve({ expenses: '5100.00', expenses_average: '5000.00' })
    renderAt(`/month/${prev}`)
    const note = await screen.findByText('About the same as usual (3-mo avg $5,000.00)')
    expect(note.className).not.toMatch(/destructive|emerald/)
  })

  it('words short windows and hides the sub-line with no history', async () => {
    serve({ average_months: 2 })
    const first = renderAt(`/month/${prev}`)
    await screen.findByText('Complete month')
    expect(await within(tile('Income')).findByText(/avg of 2 months/)).toBeInTheDocument()
    first.unmount()
    serve({
      average_months: 0, income_average: null, expenses_average: null, net_average: null, savings_rate_average: null,
    })
    renderAt(`/month/${prev}`)
    await screen.findByText('Complete month')
    expect(within(screen.getByRole('region', { name: 'Month totals' })).queryByText(/avg/)).toBeNull()
  })

  it('formats the savings rate as a percent', async () => {
    serve({ savings_rate: -0.1236 })
    renderAt(`/month/${prev}`)
    expect(await within(await screen.findByText('Savings rate').then((e) => e.closest('[data-slot="card"]') as HTMLElement)).findByText('-12.4%')).toBeInTheDocument()
  })

  it('links each essentiality legend item to the Spending breakdown', async () => {
    renderAt(`/month/${prev}`)
    const link = await screen.findByRole('link', { name: /^Flexible/ })
    expect(link).toHaveAttribute('href', `/spending?essentiality=flexible&month=${prev}`)
    expect(link).toHaveTextContent(/%$/)
    expect(screen.getByRole('link', { name: /^Not set/ })).toHaveAttribute('href', `/spending?essentiality=unset&month=${prev}`)
  })

  it('links category rows to Transactions, including Uncategorized', async () => {
    renderAt(`/month/${prev}`)
    const rent = await screen.findByRole('link', { name: /^Rent/ })
    const p = new URLSearchParams({ category: '3', start: `${prev}-01`, end: monthEnd(prev) })
    expect(rent).toHaveAttribute('href', `/transactions?${p}`)
    // 11 categories: Uncategorized is the 11th row, behind "1 more category".
    expect(screen.queryByRole('link', { name: /^Uncategorized/ })).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: /1 more category/ }))
    const u = new URLSearchParams({ uncategorized: '1', start: `${prev}-01`, end: monthEnd(prev) })
    expect(screen.getByRole('link', { name: /^Uncategorized/ })).toHaveAttribute('href', `/transactions?${u}`)
    expect(screen.queryByRole('button', { name: /more categor/ })).toBeNull()
  })

  it('shows "—" for categories near their average and signed differences otherwise', async () => {
    renderAt(`/month/${prev}`)
    // Mock factors: Groceries 0.8 (below its average), Restaurant 1.3 (above), Rent 1.0 (same).
    expect((await screen.findByRole('link', { name: /^Groceries/ })).textContent).toMatch(/−\$/)
    expect(screen.getByRole('link', { name: /^Restaurant/ }).textContent).toMatch(/\+\$/)
    expect(screen.getByRole('link', { name: /^Rent/ }).textContent).toMatch(/—/)
  })

  it('links to all transactions of the month', async () => {
    renderAt(`/month/${prev}`)
    const detail = monthDetail(prev)
    const link = await screen.findByRole('link', { name: `View all ${detail.transaction_count} transactions this month` })
    expect(link).toHaveAttribute('href', `/transactions?start=${prev}-01&end=${monthEnd(prev)}`)
  })

  it('lists the largest transactions, each opening the transaction panel', async () => {
    renderAt(`/month/${prev}`)
    const row = await screen.findByRole('button', { name: /Landlord LLC/ })
    expect(await within(row).findByText(/Rent/)).toBeInTheDocument()
  })

  it('shows an Income card above spending, one row per income transaction', async () => {
    const base = monthDetail(prev).largest[0]!
    serve({
      income_transactions: [
        { ...base, id: 1, amount: '4200.00', payee: 'Acme Corp', raw_description: 'ACME PAYROLL', posted_on: `${prev}-01`, categorization: { category_id: 1, essentiality: null, source: 'rule', confidence: 'high' } },
        { ...base, id: 2, amount: '120.00', payee: null, raw_description: 'MOBILE DEPOSIT', posted_on: `${prev}-12`, categorization: null },
      ],
    })
    renderAt(`/month/${prev}`)
    const spending = await screen.findByText('Spending by category')
    const income = cardTitle('Income')!
    expect(income).toBeDefined()
    expect(income.compareDocumentPosition(spending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const card = income.closest('[data-slot="card"]') as HTMLElement
    const rows = within(card).getAllByRole('button')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Acme Corp')
    expect(rows[0]).toHaveTextContent('$4,200.00')
    expect(await within(rows[0]!).findByText(/Salary/)).toBeInTheDocument()
    expect(rows[1]).toHaveTextContent('MOBILE DEPOSIT')
    expect(rows[1]).toHaveTextContent('Uncategorized')
  })

  it('hides the Income card when the month has no income transactions', async () => {
    serve({ income_transactions: [] })
    renderAt(`/month/${prev}`)
    await screen.findByText('Spending by category')
    expect(cardTitle('Income')).toBeUndefined()
  })

  it('shows an empty state for a month without transactions', async () => {
    serve({ transaction_count: 0, categories: [], largest: [] })
    renderAt(`/month/${prev}`)
    expect(await screen.findByText(`No transactions in ${monthLabel(prev, 'long')} yet.`)).toBeInTheDocument()
  })

  it('shows the API detail for a future month, with retry', async () => {
    renderAt(`/month/${addMonths(current, 2)}`)
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('is in the future')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('Overview entry points', () => {
  it('opens the month view from the This month tiles', async () => {
    renderAt('/')
    const user = userEvent.setup()
    await user.click(await screen.findByText('Income so far'))
    expect(await screen.findByText(/^In progress, day/)).toBeInTheDocument()
  })

  it('opens a month from a bar on the income vs expenses chart', async () => {
    renderAt('/')
    await screen.findByText('Income vs. expenses')
    await waitFor(() => expect(document.querySelectorAll('.recharts-bar-rectangle').length).toBeGreaterThan(0))
    const bar = document.querySelector('[aria-label^="Monthly income"] .recharts-bar-rectangle')!
    fireEvent.click(bar.querySelector('path') ?? bar)
    expect(await screen.findByText(/^In progress, day|^Complete month$/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Previous month' })).toBeInTheDocument()
  })
})

describe('Month view display', () => {
  const delta = (label: string) => within(tile(label)).getByTestId('delta')

  it('shows each tile against the average, coloured by whether it is good for that metric', async () => {
    serve({
      income: '5000.00', income_average: '4000.00',
      expenses: '6000.00', expenses_average: '5000.00',
      net: '-1000.00', net_average: '-500.00',
      savings_rate: -0.2, savings_rate_average: -0.125,
    })
    renderAt(`/month/${prev}`)
    await screen.findByText('Complete month')
    expect(delta('Income')).toHaveTextContent('up25%')
    expect(delta('Income')).toHaveClass('text-emerald-700')
    expect(delta('Spending')).toHaveTextContent('up20%')
    expect(delta('Spending')).toHaveClass('text-destructive')
    expect(delta('Net')).toHaveTextContent('down100%')
    expect(delta('Net')).toHaveClass('text-destructive')
    expect(delta('Savings rate')).toHaveTextContent('down7.5 pts')
    expect(delta('Savings rate')).toHaveClass('text-destructive')
  })

  it('is neutral within 5% and absent without an average', async () => {
    serve({ income: '5100.00', income_average: '5000.00', expenses_average: null, average_months: 3 })
    renderAt(`/month/${prev}`)
    await screen.findByText('Complete month')
    expect(delta('Income').className).not.toMatch(/destructive|emerald/)
    expect(within(tile('Spending')).queryByTestId('delta')).toBeNull()
  })

  it('renders a negative net and savings rate in the destructive colour', async () => {
    serve({ net: '-250.00', savings_rate: -0.05 })
    renderAt(`/month/${prev}`)
    expect(await within(await waitFor(() => tile('Net'))).findByText('-$250.00')).toHaveClass('text-destructive')
    expect(within(tile('Savings rate')).getByText('-5.0%')).toHaveClass('text-destructive')
  })

  it('keeps a positive net in the normal colour', async () => {
    serve({ net: '250.00', savings_rate: 0.05 })
    renderAt(`/month/${prev}`)
    expect(await within(await waitFor(() => tile('Net'))).findByText('$250.00')).not.toHaveClass('text-destructive')
  })

  it('shows a thin progress bar for a month in progress, none for a complete one', async () => {
    serve({ is_complete: false, days_elapsed: 25, days_in_month: 30 })
    const { unmount } = renderAt(`/month/${current}`)
    expect(await screen.findByText('In progress, day 25 of 30')).toBeInTheDocument()
    const bar = screen.getByTestId('month-progress')
    expect(bar).toHaveAttribute('aria-valuenow', '25')
    expect(bar).toHaveAttribute('aria-valuemax', '30')
    unmount()
    serve({ is_complete: true })
    renderAt(`/month/${prev}`)
    await screen.findByText('Complete month')
    expect(screen.queryByTestId('month-progress')).toBeNull()
  })
})
