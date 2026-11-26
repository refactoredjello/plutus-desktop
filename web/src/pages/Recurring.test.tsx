import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { recurring } from '@/mocks/recurring'
import { renderAt } from '@/test/render'

describe('Recurring', () => {
  it('splits proposed from confirmed and summarises annual outflow cost', async () => {
    renderAt('/recurring')
    expect(await screen.findByText('Needs review')).toBeInTheDocument()
    const review = screen.getByText('Needs review').closest('section')!
    expect(within(review).getByText('SPOTIFY USA')).toBeInTheDocument()
    expect(screen.queryByText('OLD MAGAZINE')).not.toBeInTheDocument()
    // 185.88 + 25,200 + 480 out; the discretionary and flexible ones are 185.88 + 480.
    expect(screen.getByText(/recurring bills cost/)).toHaveTextContent('$25,865.88 a year; $665.88 of that is flexible')
  })

  it('shows income distinctly and without an essentiality select', async () => {
    renderAt('/recurring')
    const row = (await screen.findByText('ACME CORP PAYROLL')).closest('tr')!
    const pay = within(row).getAllByText('+$3,150.00')[0]!
    expect(pay.className).toContain('emerald')
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('confirms a proposed charge', async () => {
    const user = userEvent.setup()
    renderAt('/recurring')
    await user.click(await screen.findByRole('button', { name: 'Confirm Spotify' }))
    await waitFor(() => expect(screen.queryByText('Needs review')).not.toBeInTheDocument())
    expect(screen.getByRole('combobox', { name: 'Essentiality for Spotify' })).toBeInTheDocument()
    expect(recurring.find((c) => c.id === 5)?.status).toBe('confirmed')
  })

  it('dismisses a proposed charge and stops tracking a confirmed one', async () => {
    const user = userEvent.setup()
    renderAt('/recurring')
    await user.click(await screen.findByRole('button', { name: 'Dismiss Spotify' }))
    await waitFor(() => expect(screen.queryByText('SPOTIFY USA')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Stop tracking GYM CO' }))
    await waitFor(() => expect(screen.queryByText('GYM CO')).not.toBeInTheDocument())
    expect(recurring.find((c) => c.merchant_key === 'GYM CO')?.status).toBe('dismissed')
    expect(screen.getByText(/recurring bills cost/)).toHaveTextContent('$25,385.88 a year')
  })

  it('edits essentiality inline', async () => {
    const user = userEvent.setup()
    renderAt('/recurring')
    await user.click(await screen.findByRole('combobox', { name: 'Essentiality for Netflix' }))
    await user.click(await screen.findByRole('option', { name: 'Essential' }))
    await waitFor(() => expect(recurring.find((c) => c.id === 1)?.essentiality).toBe('essential'))
    // Netflix no longer counts as flexible: only the gym (480) remains.
    await waitFor(() => expect(screen.getByText(/recurring bills cost/)).toHaveTextContent('$480.00 of that'))
  })
})

describe('Recurring display', () => {
  const day = (offset: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  it('shows the friendly name, with the merchant key as a secondary line', async () => {
    renderAt('/recurring')
    const row = (await screen.findByText('Netflix')).closest('tr')!
    expect(within(row).getByText('NETFLIX.COM CA')).toBeInTheDocument()
    expect(within(row).getByText('Netflix')).toHaveAttribute('title', 'NETFLIX.COM CA')
    // A charge whose name is its key shows it once.
    const gym = (await screen.findByText('GYM CO')).closest('tr')!
    expect(within(gym).getAllByText('GYM CO')).toHaveLength(1)
  })

  it('hints how far away the next charge is, overdue in a warning tone', async () => {
    const r = recurring.find((c) => c.id === 1)!
    const g = recurring.find((c) => c.id === 2)!
    const a = recurring.find((c) => c.id === 3)!
    const p = recurring.find((c) => c.id === 4)!
    r.next_expected_date = day(5)
    g.next_expected_date = day(-3)
    a.next_expected_date = day(0)
    p.next_expected_date = day(1)
    renderAt('/recurring')
    const row = async (name: string) => (await screen.findByText(name)).closest('tr')!
    expect(within(await row('Netflix')).getByText('in 5 days')).toBeInTheDocument()
    const overdue = within(await row('Landlord LLC')).getByText('3 days overdue')
    expect(overdue.className).toMatch(/amber/)
    expect(within(await row('GYM CO')).getByText('today')).toBeInTheDocument()
    expect(within(await row('Acme Corp')).getByText('tomorrow')).toBeInTheDocument()
  })
})
