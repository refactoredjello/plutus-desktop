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
    await user.click(await screen.findByRole('button', { name: 'Confirm SPOTIFY USA' }))
    await waitFor(() => expect(screen.queryByText('Needs review')).not.toBeInTheDocument())
    expect(screen.getByRole('combobox', { name: 'Essentiality for SPOTIFY USA' })).toBeInTheDocument()
    expect(recurring.find((c) => c.id === 5)?.status).toBe('confirmed')
  })

  it('dismisses a proposed charge and stops tracking a confirmed one', async () => {
    const user = userEvent.setup()
    renderAt('/recurring')
    await user.click(await screen.findByRole('button', { name: 'Dismiss SPOTIFY USA' }))
    await waitFor(() => expect(screen.queryByText('SPOTIFY USA')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Stop tracking GYM CO' }))
    await waitFor(() => expect(screen.queryByText('GYM CO')).not.toBeInTheDocument())
    expect(recurring.find((c) => c.merchant_key === 'GYM CO')?.status).toBe('dismissed')
    expect(screen.getByText(/recurring bills cost/)).toHaveTextContent('$25,385.88 a year')
  })

  it('edits essentiality inline', async () => {
    const user = userEvent.setup()
    renderAt('/recurring')
    await user.click(await screen.findByRole('combobox', { name: 'Essentiality for NETFLIX.COM CA' }))
    await user.click(await screen.findByRole('option', { name: 'Essential' }))
    await waitFor(() => expect(recurring.find((c) => c.id === 1)?.essentiality).toBe('essential'))
    // Netflix no longer counts as flexible: only the gym (480) remains.
    await waitFor(() => expect(screen.getByText(/recurring bills cost/)).toHaveTextContent('$480.00 of that'))
  })
})
