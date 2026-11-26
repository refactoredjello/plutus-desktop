import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { monthEnd, monthKey } from '@/lib/dates'
import { formatMoney } from '@/lib/money'
import { monthlySummaries } from '@/mocks/reports'
import { projection } from '@/mocks/projection'
import { server } from '@/mocks/server'
import { renderAt } from '@/test/render'

const problem = () => HttpResponse.json({ title: 'Error', status: 500, detail: 'Database unavailable' }, { status: 500 })
const tile = (label: string) => screen.getByText(label).closest('[data-slot="card"]') as HTMLElement

describe('Overview', () => {
  it('shows this-month stat tiles with last-month comparisons', async () => {
    renderAt('/')
    const monthly = monthlySummaries()
    const [prev, cur] = [monthly.at(-2)!, monthly.at(-1)!]
    const income = tile('Income so far')
    expect(await within(income).findByText(formatMoney(cur.income))).toBeInTheDocument()
    expect(within(income).getByText(`Last month: ${formatMoney(prev.income)}`)).toBeInTheDocument()
    const spent = tile('Spent so far')
    expect(within(spent).getByText(formatMoney(cur.expenses))).toBeInTheDocument()
    const projected = tile('Projected month-end balance')
    const p = projection()
    expect(await within(projected).findByText(formatMoney(p.months[0]!.projected_end_balance))).toBeInTheDocument()
    expect(within(projected).getByText(`Balance today: ${formatMoney(p.current_balance)}`)).toBeInTheDocument()
  })

  it('folds the remainder into "N more categories" without a link', async () => {
    renderAt('/')
    expect(await screen.findByRole('link', { name: /Rent/ })).toBeInTheDocument()
    const rest = screen.getByText(/^\d+ more categor(y|ies)$/)
    expect(rest.closest('a')).toBeNull()
  })

  it('links a category to Transactions with category and month range params', async () => {
    renderAt('/')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('link', { name: /Groceries/ }))
    const month = monthKey(new Date())
    expect(await screen.findByLabelText('From date')).toHaveValue(`${month}-01`)
    expect(screen.getByLabelText('To date')).toHaveValue(monthEnd(month))
    expect(screen.getByRole('combobox', { name: 'Category filter' })).toHaveTextContent('Groceries')
  })

  it('renders the projection assumptions', async () => {
    renderAt('/')
    for (const a of projection().assumptions) expect(await screen.findByText(a)).toBeInTheDocument()
  })

  it('shows a friendly empty state when there is no data yet', async () => {
    server.use(
      http.get('/api/reports/monthly', () => HttpResponse.json([])),
      http.get('/api/reports/by-category', () => HttpResponse.json([])),
      http.get('/api/reports/balances', () => HttpResponse.json([])),
    )
    renderAt('/')
    await waitFor(() => expect(screen.getAllByText(/No data yet\. Run/).length).toBe(4))
    expect(screen.getAllByRole('link', { name: 'Settings → Sync now' })[0]).toHaveAttribute('href', '/settings')
  })

  it('an error in one card does not break the others', async () => {
    server.use(http.get('/api/reports/by-category', problem))
    renderAt('/')
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(alert).toHaveTextContent('Database unavailable')
    expect(await screen.findByText(projection().assumptions[0]!)).toBeInTheDocument()
    expect(await within(tile('Income so far')).findByText(formatMoney(monthlySummaries().at(-1)!.income))).toBeInTheDocument()
    expect(screen.getByText('Income vs. expenses')).toBeInTheDocument()
  })
})

describe('Overview stat tile deltas', () => {
  it('shows the direction and size against last month, neutral while the month is in progress', async () => {
    renderAt('/')
    const monthly = monthlySummaries()
    const [prev, cur] = [monthly.at(-2)!, monthly.at(-1)!]
    const income = tile('Income so far')
    const delta = await within(income).findByTestId('delta')
    const pct = Math.round((Math.abs(Number(cur.income) - Number(prev.income)) / Number(prev.income)) * 100)
    expect(delta).toHaveTextContent(`${Number(cur.income) < Number(prev.income) ? 'down' : 'up'}${pct}%`)
    expect(delta.className).not.toMatch(/destructive|emerald/)
    expect(within(tile('Spent so far')).getByTestId('delta')).toBeInTheDocument()
    expect(within(tile('Projected month-end balance')).queryByTestId('delta')).toBeNull()
  })
})
