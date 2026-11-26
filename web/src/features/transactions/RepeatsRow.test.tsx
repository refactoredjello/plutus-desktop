import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '@/api/client'
import { recurring } from '@/mocks/recurring'
import { server } from '@/mocks/server'
import { renderAt } from '@/test/render'

/** Opens the panel for the first row, a Blue Bottle Coffee on account 3. */
async function openBlueBottle(user: ReturnType<typeof userEvent.setup>) {
  renderAt('/transactions')
  await screen.findAllByText('Blue Bottle Coffee')
  await user.click(within(screen.getAllByRole('row')[1]!).getByText('Blue Bottle Coffee'))
  return within(await screen.findByRole('dialog', { name: 'Blue Bottle Coffee' }))
}

function recordMarks() {
  const bodies: Schemas['RecurringChargeCreate'][] = []
  server.use(
    http.post('/api/recurring', async ({ request }) => {
      bodies.push((await request.clone().json()) as Schemas['RecurringChargeCreate'])
      return undefined
    }),
  )
  return bodies
}

describe('Repeats in the transaction panel', () => {
  it('marks the merchant as recurring with a cadence and whether the amount varies', async () => {
    const bodies = recordMarks()
    const user = userEvent.setup()
    const dialog = await openBlueBottle(user)
    const button = dialog.getByRole('button', { name: 'Mark as recurring' })
    expect(button).toBeDisabled()
    await user.click(dialog.getByRole('combobox', { name: 'Repeats for Blue Bottle Coffee' }))
    await user.click(await screen.findByRole('option', { name: 'Monthly' }))
    await user.click(dialog.getByRole('switch', { name: 'Amount varies for Blue Bottle Coffee' }))
    await user.click(button)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ transaction_id: 1000, cadence: 'monthly', amount_varies: true })
  })

  it('starts from the confirmed item and enables Update only after a change', async () => {
    recurring.push({
      id: 90,
      merchant_key: 'blue-bottle-coffee',
      name: 'Blue Bottle Coffee',
      account_id: 3,
      amount: '-5.75',
      cadence: 'weekly',
      next_expected_date: '2026-10-09',
      last_seen_on: '2026-10-02',
      status: 'confirmed',
      essentiality: 'discretionary',
      amount_varies: true,
      annual_cost: '-299.00',
    })
    const user = userEvent.setup()
    const dialog = await openBlueBottle(user)
    const update = await dialog.findByRole('button', { name: 'Update' })
    expect(dialog.getByRole('combobox', { name: 'Repeats for Blue Bottle Coffee' })).toHaveTextContent('Weekly')
    const toggle = dialog.getByRole('switch', { name: 'Amount varies for Blue Bottle Coffee' })
    expect(toggle).toBeChecked()
    expect(update).toBeDisabled()
    await user.click(toggle)
    expect(update).toBeEnabled()
    await user.click(toggle)
    expect(update).toBeDisabled()
  })

  it('is disabled with a hint while the transaction has no merchant', async () => {
    const user = userEvent.setup()
    renderAt('/transactions?q=POS+DEBIT')
    const cells = await screen.findAllByText('POS DEBIT 88213 SQ *PAYMENT')
    await user.click(cells[0]!)
    const dialog = within(await screen.findByRole('dialog', { name: 'POS DEBIT 88213 SQ *PAYMENT' }))
    expect(dialog.getByText('No merchant yet; categorize it first.')).toBeInTheDocument()
    expect(dialog.getByRole('combobox', { name: 'Repeats for POS DEBIT 88213 SQ *PAYMENT' })).toBeDisabled()
    expect(dialog.getByRole('button', { name: 'Mark as recurring' })).toBeDisabled()
  })

  it('is absent for a transfer', async () => {
    const user = userEvent.setup()
    renderAt('/transactions?transfers=1&q=transfer')
    await user.click(await screen.findByText('TRANSFER TO SAVINGS'))
    const dialog = within(await screen.findByRole('dialog', { name: 'TRANSFER TO SAVINGS' }))
    expect(dialog.queryByRole('combobox', { name: /^Repeats for/ })).not.toBeInTheDocument()
    expect(dialog.queryByRole('switch', { name: /^Amount varies for/ })).not.toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Mark as recurring' })).not.toBeInTheDocument()
  })
})
