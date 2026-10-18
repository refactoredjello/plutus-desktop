import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/mocks/server'
import { renderAt } from '@/test/render'

/** The mock data's one paired transfer, shown when transfers are included (it sorts last, hence the search). */
const TRANSFERS = '/transactions?transfers=1&q=transfer'

async function transferRow() {
  const cell = await screen.findByText('TRANSFER TO SAVINGS')
  return cell.closest('tr')!
}

function recordUnpairs(status = 200) {
  const ids: number[] = []
  server.use(
    http.post('/api/transactions/:id/unpair', ({ params }) => {
      ids.push(Number(params.id))
      if (status !== 200) {
        return HttpResponse.json({ title: 'Bad Request', status, detail: 'Transaction 500 is not a transfer' }, { status })
      }
      return undefined // the default mock handler answers
    }),
  )
  return ids
}

describe('Unpair a transfer', () => {
  it('shows Unpair only on paired transfers', async () => {
    const { unmount } = renderAt(TRANSFERS)
    expect(within(await transferRow()).getByRole('button', { name: /Unpair/ })).toBeInTheDocument()
    unmount()
    renderAt('/transactions?transfers=1')
    await screen.findAllByText('Blue Bottle Coffee')
    expect(screen.queryByRole('button', { name: /Unpair/ })).not.toBeInTheDocument()
  })

  it('asks first, then unpairs and refreshes the list', async () => {
    const ids = recordUnpairs()
    const user = userEvent.setup()
    renderAt(TRANSFERS)
    await user.click(within(await transferRow()).getByRole('button', { name: /Unpair/ }))
    expect(await screen.findByText(/count as spending or income again/)).toBeInTheDocument()
    expect(ids).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Unpair transfer' }))
    await waitFor(() => expect(ids).toEqual([500]))
    // The refreshed row is an ordinary transaction now.
    await waitFor(async () => expect(within(await transferRow()).queryByRole('button', { name: /Unpair/ })).toBeNull())
  })

  it('does nothing when cancelled', async () => {
    const ids = recordUnpairs()
    const user = userEvent.setup()
    renderAt(TRANSFERS)
    await user.click(within(await transferRow()).getByRole('button', { name: /Unpair/ }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText(/count as spending or income again/)).toBeNull())
    expect(ids).toEqual([])
  })

  it('shows the error when unpairing fails', async () => {
    recordUnpairs(400)
    const user = userEvent.setup()
    renderAt(TRANSFERS)
    await user.click(within(await transferRow()).getByRole('button', { name: /Unpair/ }))
    await user.click(await screen.findByRole('button', { name: 'Unpair transfer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Transaction 500 is not a transfer')
  })
})
