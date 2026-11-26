import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { goals, mockFlags } from '@/mocks/goals'
import { toasts } from '@/test/motion'
import { renderAt } from '@/test/render'

const card = async (name: string) => (await screen.findByText(name)).closest('[data-slot="card"]') as HTMLElement

describe('Goals', () => {
  it('shows progress, plain-language monthly figures, and the on-track badge', async () => {
    renderAt('/goals')
    const vacation = within(await card('Vacation fund'))
    expect(vacation.getByText('$3,000.00 of $9,000.00')).toBeInTheDocument()
    expect(vacation.getByText(/You need \$750.00\/month; you've averaged \$650.00\./)).toBeInTheDocument()
    expect(vacation.getByText('Behind')).toBeInTheDocument()
    expect(vacation.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33.33333333333333')
    expect(within(await card('Emergency fund')).getByText('On track')).toBeInTheDocument()
  })

  it('creates a goal', async () => {
    const user = userEvent.setup()
    renderAt('/goals')
    await user.click(await screen.findByRole('button', { name: 'New goal' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'New laptop')
    await user.type(within(dialog).getByLabelText('Target amount'), '1800')
    fireEvent.change(within(dialog).getByLabelText('Target date'), { target: { value: '2027-06-01' } })
    await user.click(within(dialog).getByRole('button', { name: 'Create goal' }))
    expect(await screen.findByText('New laptop')).toBeInTheDocument()
    expect(goals.at(-1)).toMatchObject({ target_amount: '1800.00', target_date: '2027-06-01' })
  })

  it('archives a goal after confirming', async () => {
    const user = userEvent.setup()
    renderAt('/goals')
    await screen.findByText('Emergency fund')
    await user.click(screen.getByRole('button', { name: 'Archive Emergency fund' }))
    await user.click(screen.getByRole('button', { name: 'Confirm archive Emergency fund' }))
    await waitFor(() => expect(screen.queryByText('Emergency fund')).not.toBeInTheDocument())
    expect(goals.find((g) => g.id === 2)?.is_active).toBe(false)
  })

  it('suggests ways to save, with a loading state, then keeps and dismisses', async () => {
    const user = userEvent.setup()
    renderAt('/goals')
    const vacation = within(await card('Vacation fund'))
    await user.click(vacation.getByRole('button', { name: 'Suggest ways to save' }))
    expect(await vacation.findByRole('button', { name: 'Thinking…' })).toBeDisabled()

    expect(await vacation.findByText('Cancel unused subscriptions')).toBeInTheDocument()
    expect(vacation.getByText('Save about $45.00/month')).toBeInTheDocument()

    await user.click(vacation.getByRole('button', { name: 'Keep: Cancel unused subscriptions' }))
    await waitFor(() => expect(vacation.queryByRole('button', { name: 'Keep: Cancel unused subscriptions' })).not.toBeInTheDocument())
    expect(vacation.getByText('Kept')).toBeInTheDocument()

    await user.click(vacation.getByRole('button', { name: 'Dismiss: Cook at home twice more a week' }))
    await waitFor(() => expect(vacation.queryByText('Cook at home twice more a week')).not.toBeInTheDocument())
    await user.click(vacation.getByRole('button', { name: 'Show dismissed (1)' }))
    expect(vacation.getByText('Cook at home twice more a week')).toBeInTheDocument()
    expect(vacation.getByText('Cancel unused subscriptions')).toBeInTheDocument()
  })

  it('shows the problem detail when suggestions fail', async () => {
    mockFlags.suggestFailure = 'The AI service is unavailable'
    const user = userEvent.setup()
    renderAt('/goals')
    const vacation = within(await card('Vacation fund'))
    await user.click(vacation.getByRole('button', { name: 'Suggest ways to save' }))
    expect(await toasts().findByText('The AI service is unavailable')).toBeInTheDocument()
    expect(vacation.getByRole('button', { name: 'Suggest ways to save' })).toBeEnabled()
  })
})
