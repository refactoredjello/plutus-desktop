import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { addMonths, monthKey } from '@/lib/dates'
import { transactions } from '@/mocks/transactions'
import { renderAt } from '@/test/render'

/** First data row: a pending Blue Bottle Coffee. */
async function firstRow() {
  await screen.findAllByText('Blue Bottle Coffee')
  return screen.getAllByRole('row')[1]!
}

describe('The row open in the transaction panel', () => {
  it('is marked while the panel shows it, unmarked on close, and gets focus back', async () => {
    const user = userEvent.setup()
    renderAt('/transactions')
    const row = await firstRow()
    expect(row).not.toHaveAttribute('data-state', 'selected')
    row.focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('dialog', { name: 'Blue Bottle Coffee' })
    expect(row).toHaveAttribute('data-state', 'selected')
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(screen.getAllByRole('row', { hidden: true }).filter((r) => r.getAttribute('data-state') === 'selected')).toHaveLength(1)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(row).not.toHaveAttribute('data-state', 'selected'))
    expect(row).not.toHaveAttribute('aria-current')
    await waitFor(() => expect(row).toHaveFocus())
  })

  it('is marked on Review', async () => {
    const user = userEvent.setup()
    renderAt('/review')
    const row = (await screen.findAllByRole('row', { name: / on / }))[0]!
    await user.click(row.querySelector('td')!)
    await screen.findByRole('dialog')
    expect(row).toHaveAttribute('data-state', 'selected')
  })

  it('is marked in the Month lists', async () => {
    const user = userEvent.setup()
    renderAt(`/month/${addMonths(monthKey(new Date()), -1)}`)
    const item = await screen.findByRole('button', { name: /Landlord LLC/ })
    await user.click(item)
    await screen.findByRole('dialog')
    expect(item).toHaveAttribute('aria-current', 'true')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(item).not.toHaveAttribute('aria-current'))
  })
})

describe('Transaction panel details', () => {
  it('shows the note and the pending and one-time badges', async () => {
    Object.assign(transactions[0]!, { note: 'Split with Sam', one_time: true })
    const user = userEvent.setup()
    renderAt('/transactions')
    await user.click(within(await firstRow()).getByText('Blue Bottle Coffee'))
    const details = within(within(await screen.findByRole('dialog')).getByRole('region', { name: 'Details' }))
    expect(details.getByText('Note')).toBeInTheDocument()
    expect(details.getByText('Split with Sam')).toBeInTheDocument()
    for (const badge of ['Pending', 'One-time']) expect(details.getByText(badge)).toBeInTheDocument()
  })

  it('shows the transfer badge', async () => {
    const user = userEvent.setup()
    renderAt('/transactions?transfers=1&q=transfer')
    await user.click(await screen.findByText('TRANSFER TO SAVINGS'))
    const details = within(within(await screen.findByRole('dialog')).getByRole('region', { name: 'Details' }))
    expect(details.getByText('Transfer')).toBeInTheDocument()
  })
})
