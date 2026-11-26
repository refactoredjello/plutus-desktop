import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '@/api/client'
import { recurring } from '@/mocks/recurring'
import { server } from '@/mocks/server'
import { toasts } from '@/test/motion'
import { renderAt } from '@/test/render'

async function netflixRow() {
  await screen.findAllByText('Netflix')
  return screen.getAllByText('Netflix')[0]!.closest('tr')!
}

describe('Mark as recurring', () => {
  it('shows the button on a normal row and not on a transfer', async () => {
    renderAt('/transactions')
    const row = await netflixRow()
    expect(within(row).getByRole('button', { name: 'Mark Netflix as recurring' })).toBeInTheDocument()
  })

  it('omits the button on a transfer', async () => {
    renderAt('/transactions?transfers=1&q=TRANSFER+TO')
    const transfer = (await screen.findByText('TRANSFER TO SAVINGS')).closest('tr')!
    expect(within(transfer).getByRole('button', { name: /Add note/ })).toBeInTheDocument()
    expect(within(transfer).queryByRole('button', { name: /as recurring/ })).not.toBeInTheDocument()
  })

  it('sends the chosen cadence, confirms in a toast with a link, and the Recurring page lists it', async () => {
    const bodies: Schemas['RecurringChargeCreate'][] = []
    server.use(
      http.post('/api/recurring', async ({ request }) => {
        bodies.push((await request.clone().json()) as Schemas['RecurringChargeCreate'])
        return undefined
      }),
    )
    const user = userEvent.setup()
    renderAt('/transactions')
    const row = await netflixRow()
    await user.click(within(row).getByRole('button', { name: 'Mark Netflix as recurring' }))
    await user.click(await screen.findByRole('radio', { name: 'Yearly' }))
    await user.click(screen.getByRole('button', { name: 'Mark as recurring' }))
    expect(await toasts().findByText('Marked recurring yearly')).toBeInTheDocument()
    expect(within(row).queryByText(/Recurring yearly/)).not.toBeInTheDocument()
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ cadence: 'yearly' })
    expect(typeof bodies[0]!.transaction_id).toBe('number')
    expect(recurring.some((c) => c.merchant_key === 'NETFLIX' && c.cadence === 'yearly')).toBe(true)

    await user.click(toasts().getByRole('button', { name: 'View' }))
    expect(await screen.findByText('NETFLIX')).toBeInTheDocument()
  })

  it('shows the problem detail on a 400', async () => {
    server.use(
      http.post('/api/recurring', () =>
        HttpResponse.json({ title: 'Bad Request', status: 400, detail: 'No merchant yet' }, { status: 400 }),
      ),
    )
    const user = userEvent.setup()
    renderAt('/transactions')
    const row = await netflixRow()
    await user.click(within(row).getByRole('button', { name: 'Mark Netflix as recurring' }))
    await user.click(await screen.findByRole('button', { name: 'Mark as recurring' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No merchant yet')
    expect(toasts().queryByText(/Marked recurring/)).not.toBeInTheDocument()
  })

  it('is on Review rows too', async () => {
    renderAt('/review')
    await screen.findAllByText('Amazon')
    expect(screen.getAllByRole('button', { name: /as recurring/ }).length).toBeGreaterThan(0)
  })
})
