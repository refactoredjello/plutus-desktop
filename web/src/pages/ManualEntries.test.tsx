import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { plannedEntries } from '@/mocks/planned'
import { server } from '@/mocks/server'
import { renderAt } from '@/test/render'

describe('Planned', () => {
  it('lists planned items with signed amounts and status', async () => {
    renderAt('/planned')
    const row = (await screen.findByText('Freelance invoice')).closest('tr')!
    expect(within(row).getByText('+$500.00').className).toContain('emerald')
    expect(within(row).getByText('Open')).toBeInTheDocument()
    expect(within(screen.getByText('Dentist').closest('tr')!).getByText('Fulfilled')).toBeInTheDocument()
    expect(screen.getByText('-$1,200.00')).toBeInTheDocument()
  })

  it('adds an expense as a negative amount', async () => {
    const user = userEvent.setup()
    renderAt('/planned')
    await user.click(await screen.findByRole('button', { name: 'Add planned item' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Expense' })).toHaveAttribute('aria-pressed', 'true')
    await user.type(within(dialog).getByLabelText('Amount'), '45.5')
    await user.type(within(dialog).getByLabelText('Description'), 'Parking permit')
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-12-01' } })
    await user.click(within(dialog).getByRole('button', { name: 'Add' }))

    expect(await screen.findByText('Parking permit')).toBeInTheDocument()
    expect(plannedEntries.at(-1)).toMatchObject({ amount: '-45.50', due_date: '2026-12-01', recurrence: 'none' })
  })

  it('saves a category picked from the searchable list', async () => {
    const user = userEvent.setup()
    renderAt('/planned')
    await user.click(await screen.findByRole('button', { name: 'Add planned item' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Amount'), '12')
    await user.type(within(dialog).getByLabelText('Description'), 'Beans')
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-12-01' } })
    await user.click(within(dialog).getByRole('combobox', { name: 'Category' }))
    await user.type(await screen.findByPlaceholderText('Search categories'), 'grocer')
    await user.click(await screen.findByRole('option', { name: 'Groceries' }))
    await user.click(within(dialog).getByRole('button', { name: 'Add' }))
    await screen.findByText('Beans')
    expect(plannedEntries.at(-1)).toMatchObject({ description: 'Beans', category_id: 7 })
  })

  it('adds income as a positive amount', async () => {
    const user = userEvent.setup()
    renderAt('/planned')
    await user.click(await screen.findByRole('button', { name: 'Add planned item' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Income' }))
    await user.type(within(dialog).getByLabelText('Amount'), '100')
    await user.type(within(dialog).getByLabelText('Description'), 'Refund')
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-12-01' } })
    await user.click(within(dialog).getByRole('button', { name: 'Add' }))
    await screen.findByText('Refund')
    expect(plannedEntries.at(-1)?.amount).toBe('100.00')
  })

  it('shows the end date only for repeating items', async () => {
    const user = userEvent.setup()
    renderAt('/planned')
    await user.click(await screen.findByRole('button', { name: 'Add planned item' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByLabelText(/End date/)).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('combobox', { name: 'Repeats' }))
    await user.click(await screen.findByRole('option', { name: 'Monthly' }))
    expect(within(dialog).getByLabelText(/End date/)).toBeInTheDocument()
  })

  it('shows the API detail on a 400', async () => {
    server.use(
      http.post('/api/manual-entries', () =>
        HttpResponse.json({ title: 'Bad Request', status: 400, detail: 'end_date must be on or after due_date' }, { status: 400 }),
      ),
    )
    const user = userEvent.setup()
    renderAt('/planned')
    await user.click(await screen.findByRole('button', { name: 'Add planned item' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Amount'), '10')
    await user.type(within(dialog).getByLabelText('Description'), 'Thing')
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-12-01' } })
    await user.click(within(dialog).getByRole('button', { name: 'Add' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('end_date must be on or after due_date')
  })

  it('edits an item through the same dialog', async () => {
    const user = userEvent.setup()
    renderAt('/planned')
    await user.click(await screen.findByRole('button', { name: 'Edit Freelance invoice' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Income' })).toHaveAttribute('aria-pressed', 'true')
    const amount = within(dialog).getByLabelText('Amount')
    await user.clear(amount)
    await user.type(amount, '650')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('+$650.00')).toBeInTheDocument()
  })

  it('deletes after confirming', async () => {
    const user = userEvent.setup()
    renderAt('/planned')
    await user.click(await screen.findByRole('button', { name: 'Delete Dentist' }))
    const dialog = await screen.findByRole('dialog')
    expect(plannedEntries).toHaveLength(3)
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('Dentist')).not.toBeInTheDocument())
    expect(plannedEntries).toHaveLength(2)
  })
})
