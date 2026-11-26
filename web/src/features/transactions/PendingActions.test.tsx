import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/mocks/server'
import { transactions } from '@/mocks/transactions'
import { renderAt } from '@/test/render'

/** Records the pending actions the panel sends, then lets the mock handlers answer. */
function recordCalls() {
  const calls: string[] = []
  const record = ({ request }: { request: Request }) => {
    calls.push(`${request.method} ${new URL(request.url).pathname}`)
    return undefined
  }
  server.use(http.post('/api/transactions/:id/mark-posted', record), http.delete('/api/transactions/:id', record))
  return calls
}

/** Open the panel for the stale pending Whole Foods charge (the second row). */
async function openStale() {
  const user = userEvent.setup()
  renderAt('/transactions')
  await screen.findAllByText('Blue Bottle Coffee')
  const row = screen.getAllByRole('row')[2]!
  await user.click(within(row).getByText('Whole Foods'))
  return { user, dialog: await screen.findByRole('dialog', { name: 'Whole Foods' }) }
}

describe('Pending transaction actions', () => {
  it('shows why a stale pending charge needs review', async () => {
    const { dialog } = await openStale()
    expect(within(dialog).getByText('Pending for over 44 days')).toBeInTheDocument()
  })

  it('marks a pending charge as posted', async () => {
    const calls = recordCalls()
    const { user, dialog } = await openStale()
    const id = transactions[1]!.id
    await user.click(within(dialog).getByRole('button', { name: 'Mark as posted' }))
    await waitFor(() => expect(calls).toEqual([`POST /api/transactions/${id}/mark-posted`]))
    await waitFor(() => expect(within(dialog).queryByText('Pending')).not.toBeInTheDocument())
    expect(within(dialog).queryByRole('button', { name: 'Mark as posted' })).not.toBeInTheDocument()
  })

  it('removes a pending hold after a confirm, and closes the panel', async () => {
    const calls = recordCalls()
    const { user, dialog } = await openStale()
    const id = transactions[1]!.id
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    expect(calls).toEqual([])
    await user.click(await screen.findByRole('button', { name: 'Remove transaction' }))
    await waitFor(() => expect(calls).toEqual([`DELETE /api/transactions/${id}`]))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Whole Foods' })).not.toBeInTheDocument())
  })

  it('offers no pending actions on a posted transaction', async () => {
    const user = userEvent.setup()
    renderAt('/transactions')
    await screen.findAllByText('Blue Bottle Coffee')
    await user.click(within(screen.getAllByRole('row')[3]!).getByText('Netflix'))
    const dialog = await screen.findByRole('dialog', { name: 'Netflix' })
    expect(within(dialog).queryByRole('button', { name: 'Mark as posted' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })
})
