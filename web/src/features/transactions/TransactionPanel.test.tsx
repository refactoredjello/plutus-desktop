import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '@/api/client'
import { addMonths, monthKey } from '@/lib/dates'
import { categories } from '@/mocks/categories'
import { rules } from '@/mocks/rules'
import { server } from '@/mocks/server'
import { transactions } from '@/mocks/transactions'
import { toasts } from '@/test/motion'
import { renderAt } from '@/test/render'

const groceries = categories.find((c) => c.detailed === 'FOOD_AND_DRINK_GROCERIES')!.id
const coffee = categories.find((c) => c.detailed === 'FOOD_AND_DRINK_COFFEE')!.id
const blueBottleCount = transactions.filter((t) => t.merchant_key === 'blue-bottle-coffee').length

/** First data row: a pending Blue Bottle Coffee. */
async function firstRow() {
  await screen.findAllByText('Blue Bottle Coffee')
  return screen.getAllByRole('row')[1]!
}

const panel = () => screen.findByRole('dialog', { name: 'Blue Bottle Coffee' })

/** Records rule creates and edits, then lets the mock handlers answer. */
function recordRuleSaves() {
  const saves: { method: string; url: string; body: unknown }[] = []
  const record = async ({ request }: { request: Request }) => {
    saves.push({ method: request.method, url: new URL(request.url).pathname, body: await request.clone().json() })
    return undefined
  }
  server.use(http.post('/api/rules', record), http.patch('/api/rules/:id', record))
  return saves
}

describe('Transaction panel', () => {
  it('opens on a row click with the full bank description, memo, and account', async () => {
    const user = userEvent.setup()
    renderAt('/transactions')
    await user.click(within(await firstRow()).getByText('Blue Bottle Coffee'))
    const dialog = await panel()
    expect(within(dialog).getByText('BLUE BOTTLE COFFEE #112 SF CA')).toBeInTheDocument()
    expect(within(dialog).getByText('Card ending 4242')).toBeInTheDocument()
    expect(within(dialog).getByText('Pending')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'View in Transactions' })).toHaveAttribute(
      'href',
      expect.stringContaining('q=Blue+Bottle+Coffee'),
    )
  })

  it('opens with Enter on a focused row', async () => {
    const user = userEvent.setup()
    renderAt('/transactions')
    const row = await firstRow()
    row.focus()
    await user.keyboard('{Enter}')
    expect(await panel()).toBeInTheDocument()
  })

  it('does not open from the controls inside a row', async () => {
    const user = userEvent.setup()
    renderAt('/transactions')
    const row = await firstRow()
    await user.click(within(row).getByRole('combobox', { name: /Category for/ }))
    await user.keyboard('{Escape}')
    await user.click(within(row).getByRole('button', { name: /Add note for/ }))
    await user.type(await screen.findByRole('textbox', { name: /^Note for/ }), 'x')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Blue Bottle Coffee' })).not.toBeInTheDocument()
  })

  it('opens at the rule section from the row rule button, in create mode, and saves with POST', async () => {
    const saves = recordRuleSaves()
    const user = userEvent.setup()
    renderAt('/transactions')
    await user.click(within(await firstRow()).getByRole('button', { name: 'Rule for Blue Bottle Coffee' }))
    const dialog = await panel()
    const section = within(dialog).getByRole('region', { name: 'Rule' })
    await waitFor(() => expect(section).toHaveFocus())
    expect(await within(section).findByText('No rule matches this transaction yet.')).toBeInTheDocument()
    expect(within(section).getByRole('textbox', { name: 'Pattern' })).toHaveValue('blue-bottle-coffee')
    expect(within(section).getByRole('combobox', { name: 'Category' })).toHaveTextContent('Coffee')
    expect(await within(section).findByText(`Matches ${blueBottleCount} transactions.`)).toBeInTheDocument()

    await user.click(within(section).getByRole('button', { name: 'Create rule' }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]).toMatchObject({
      method: 'POST',
      url: '/api/rules',
      body: { match_type: 'exact', pattern: 'blue-bottle-coffee', category_id: coffee, essentiality: 'discretionary' },
    })
    expect(await toasts().findByText('Rule created')).toBeInTheDocument()
    expect(within(section).queryByText('Rule saved.')).not.toBeInTheDocument()
    expect(await within(section).findByRole('button', { name: 'Save rule' })).toBeInTheDocument()
  })

  it('edits the rule that matches, and saves with PATCH', async () => {
    rules.push({ id: 50, match_type: 'exact', pattern: 'blue-bottle-coffee', category_id: coffee, essentiality: null, created_at: '2026-10-01T00:00:00Z' })
    const saves = recordRuleSaves()
    const user = userEvent.setup()
    renderAt('/transactions')
    await user.click(within(await firstRow()).getByText('Blue Bottle Coffee'))
    const section = within(await panel()).getByRole('region', { name: 'Rule' })
    expect(await within(section).findByText('This rule categorizes this transaction.')).toBeInTheDocument()
    expect(within(section).getByRole('combobox', { name: 'Essentiality' })).toHaveTextContent('Not set')

    await user.click(within(section).getByRole('combobox', { name: 'Category' }))
    await user.click(await screen.findByRole('option', { name: 'Groceries' }))
    await user.click(within(section).getByRole('button', { name: 'Save rule' }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]).toMatchObject({ method: 'PATCH', url: '/api/rules/50', body: { category_id: groceries, essentiality: null } })
  })

  it('counts matches and the ones set by hand, and follows the match type until the pattern is edited', async () => {
    const manual = transactions.find((t) => t.merchant_key === 'blue-bottle-coffee' && t.id !== 1000)!
    manual.categorization = { ...manual.categorization!, source: 'manual' }
    const user = userEvent.setup()
    renderAt('/transactions')
    await user.click(within(await firstRow()).getByRole('button', { name: 'Rule for Blue Bottle Coffee' }))
    const section = within(await panel()).getByRole('region', { name: 'Rule' })
    expect(
      await within(section).findByText(`Matches ${blueBottleCount} transactions; 1 set by hand stays as it is.`),
    ).toBeInTheDocument()

    const pattern = within(section).getByRole('textbox', { name: 'Pattern' })
    await user.click(within(section).getByRole('combobox', { name: 'Match type' }))
    await user.click(await screen.findByRole('option', { name: 'Bank description contains' }))
    expect(pattern).toHaveValue('Blue Bottle Coffee')
    await user.clear(pattern)
    expect(within(section).getByRole('button', { name: 'Create rule' })).toBeDisabled()
    await user.type(pattern, 'zzz')
    expect(await within(section).findByText('Matches 0 transactions.')).toBeInTheDocument()
    await user.click(within(section).getByRole('combobox', { name: 'Match type' }))
    await user.click(await screen.findByRole('option', { name: 'Merchant starts with' }))
    expect(pattern).toHaveValue('zzz')
  })

  it('hides the rule button and the rule form for transfers', async () => {
    const user = userEvent.setup()
    renderAt('/transactions?transfers=1&q=transfer')
    const cell = await screen.findByText('TRANSFER TO SAVINGS')
    const row = cell.closest('tr')!
    expect(within(row).queryByRole('button', { name: /^Rule for/ })).not.toBeInTheDocument()
    await user.click(cell)
    const dialog = await screen.findByRole('dialog', { name: 'TRANSFER TO SAVINGS' })
    expect(within(dialog).getByText('Rules never categorize transfers.')).toBeInTheDocument()
  })

  it('changes the category from the panel', async () => {
    const bodies: Schemas['TransactionUpdate'][] = []
    server.use(
      http.patch('/api/transactions/:id', async ({ request }) => {
        bodies.push((await request.clone().json()) as Schemas['TransactionUpdate'])
        return undefined
      }),
    )
    const user = userEvent.setup()
    renderAt('/transactions')
    await user.click(within(await firstRow()).getByText('Blue Bottle Coffee'))
    const dialog = await panel()
    await user.click(within(dialog).getByRole('combobox', { name: 'Category for Blue Bottle Coffee' }))
    await user.click(await screen.findByRole('option', { name: 'Groceries' }))
    await waitFor(() => expect(bodies[0]).toMatchObject({ category_id: groceries }))
    expect(within(dialog).getByRole('combobox', { name: 'Category for Blue Bottle Coffee' })).toHaveTextContent('Groceries')
  })
})

describe('Make this a rule', () => {
  it('opens the rule section prefilled with the new category', async () => {
    const user = userEvent.setup()
    renderAt('/transactions')
    const row = await firstRow()
    await user.click(within(row).getByRole('combobox', { name: /Category for/ }))
    await user.click(await screen.findByRole('option', { name: 'Groceries' }))
    await user.click(await within(row).findByRole('button', { name: 'Make this a rule' }))
    const section = within(await panel()).getByRole('region', { name: 'Rule' })
    await waitFor(() => expect(section).toHaveFocus())
    expect(await within(section).findByRole('combobox', { name: 'Category' })).toHaveTextContent('Groceries')
  })
})

describe('Month lists', () => {
  it('open the panel from a row', async () => {
    const user = userEvent.setup()
    renderAt(`/month/${addMonths(monthKey(new Date()), -1)}`)
    await user.click(await screen.findByRole('button', { name: /Landlord LLC/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Landlord LLC' })
    expect(within(dialog).getByText('ACH WITHDRAWAL LANDLORD LLC RENT')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'View in Transactions' })).toHaveAttribute(
      'href',
      expect.stringContaining('q=Landlord+LLC'),
    )
  })
})
