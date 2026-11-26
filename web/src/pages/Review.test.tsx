import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '@/api/client'
import { server } from '@/mocks/server'
import { needsReview, transactions } from '@/mocks/transactions'
import { setReducedMotion, toasts } from '@/test/motion'
import { renderAt } from '@/test/render'

const queue = () => transactions.filter((t) => !t.is_transfer && needsReview(t))

describe('Review queue', () => {
  it('shows the count in the header and as a nav badge', async () => {
    renderAt('/review')
    const n = queue().length
    expect(await screen.findByText(`${n} to review`)).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: `Review ${n}` })).toBeInTheDocument()
  })

  it('lists only review rows, with "Looks right" only where there is a category to confirm', async () => {
    renderAt('/review')
    await screen.findAllByText('Amazon')
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(queue().length)
    expect(screen.getAllByRole('button', { name: 'Looks right' })).toHaveLength(
      queue().filter((t) => t.categorization && !t.review_reason).length,
    )
  })

  it('shows the reason on a pending charge past the sync reach', async () => {
    renderAt('/review')
    const reason = await screen.findByText('Pending for over 44 days')
    expect(within(reason.closest('tr')!).getByText('Whole Foods')).toBeInTheDocument()
  })

  it('accepts the current category and removes the row; the badge drops', async () => {
    const bodies: Schemas['TransactionUpdate'][] = []
    const user = userEvent.setup()
    server.use(
      http.patch('/api/transactions/:id', async ({ request, params }) => {
        const body = (await request.json()) as Schemas['TransactionUpdate']
        bodies.push(body)
        const txn = transactions.find((t) => t.id === Number(params.id))!
        txn.categorization = { ...txn.categorization!, source: 'manual', confidence: 'very_high' }
        return HttpResponse.json(txn)
      }),
    )
    renderAt('/review')
    const n = queue().length
    await screen.findByText(`${n} to review`)
    const firstWithCategory = queue().find((t) => t.categorization && !t.review_reason)!
    const before = screen.getAllByRole('button', { name: 'Looks right' }).length
    await user.click(screen.getAllByRole('button', { name: 'Looks right' })[0]!)

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ category_id: firstWithCategory.categorization!.category_id })
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Looks right' }).length).toBeLessThan(before))
    expect(await screen.findByText(`${n - 1} to review`)).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: `Review ${n - 1}` })).toBeInTheDocument()
    expect(await toasts().findByText('Category confirmed')).toBeInTheDocument()
  })

  /** Click the first "Looks right"; return its row and where focus should land next. */
  async function looksRightOnFirst() {
    const user = userEvent.setup()
    renderAt('/review')
    await screen.findAllByText('Amazon')
    const button = screen.getAllByRole('button', { name: 'Looks right' })[0]!
    const row = button.closest('tr')!
    const next = row.nextElementSibling as HTMLElement
    const target = within(next).queryByRole('button', { name: 'Looks right' }) ?? next
    const before = screen.getAllByRole('button', { name: 'Looks right' }).length
    await user.click(button)
    return { row, target, before }
  }

  it('fades a cleared row out, then removes it and focuses the next row', async () => {
    const { row, target, before } = await looksRightOnFirst()
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Looks right' }).length).toBeLessThan(before))
    expect(row).toHaveAttribute('data-leaving')
    expect(row.isConnected).toBe(true)
    await waitFor(() => expect(row.isConnected).toBe(false))
    expect(target).toHaveFocus()
  })

  it('removes a cleared row at once with reduced motion', async () => {
    setReducedMotion(true)
    const { row, target, before } = await looksRightOnFirst()
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Looks right' }).length).toBeLessThan(before))
    expect(row.isConnected).toBe(false)
    expect(target).toHaveFocus()
  })

  it('keeps a row with the rule offer until it is dismissed, then drops it', async () => {
    const user = userEvent.setup()
    renderAt('/review')
    const [row] = (await screen.findAllByText('Amazon')).map((el) => el.closest('tr')!)
    await user.click(within(row!).getByRole('combobox', { name: /Category for/ }))
    await user.click(await screen.findByRole('option', { name: 'Groceries' }))
    expect(await within(row!).findByRole('button', { name: 'Make this a rule' })).toBeInTheDocument()
    expect(row!.isConnected).toBe(true)
    await user.click(within(row!).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(row!.isConnected).toBe(false))
  })

  it('keeps the row while its rule is open in the panel, and drops it when the panel closes', async () => {
    const user = userEvent.setup()
    renderAt('/review')
    const [row] = (await screen.findAllByText('Amazon')).map((el) => el.closest('tr')!)
    await user.click(within(row!).getByRole('combobox', { name: /Category for/ }))
    await user.click(await screen.findByRole('option', { name: 'Groceries' }))
    await user.click(await within(row!).findByRole('button', { name: 'Make this a rule' }))
    const dialog = await screen.findByRole('dialog', { name: 'Amazon' })
    const section = within(dialog).getByRole('region', { name: 'Rule' })
    await user.click(await within(section).findByRole('combobox', { name: 'Match type' }))
    await user.click(await screen.findByRole('option', { name: 'Bank description contains' }))
    // A contains rule starts from the bank description when it does not contain the payee.
    expect(within(section).getByRole('textbox', { name: 'Pattern' })).toHaveValue('AMZN Mktp US*2K4LM0 AMZN.COM/BILL WA')
    expect(row!.isConnected).toBe(true)
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(row!.isConnected).toBe(false))
  })

  it('filters to uncategorized transactions', async () => {
    const urls: URL[] = []
    server.use(
      http.get('/api/transactions', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('limit') !== '1') urls.push(url) // limit=1 is the nav badge
        return undefined
      }),
    )
    const user = userEvent.setup()
    renderAt('/review')
    await screen.findAllByText('Amazon')
    await user.click(screen.getByRole('button', { name: 'No category' }))
    await waitFor(() => expect(urls.some((u) => u.searchParams.get('uncategorized') === 'true')).toBe(true))
    await waitFor(() => expect(screen.queryByText('Amazon')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Looks right' })).not.toBeInTheDocument()
  })

  it('shows only categorized low-confidence rows under Low confidence', async () => {
    const user = userEvent.setup()
    renderAt('/review')
    await screen.findAllByText('Amazon')
    await user.click(screen.getByRole('button', { name: 'Low confidence' }))
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(within(row).getByRole('button', { name: 'Looks right' })).toBeInTheDocument()
  })

  it('shows an empty state and no badge when nothing needs review', async () => {
    server.use(http.get('/api/transactions', () => HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 })))
    renderAt('/review')
    expect(await screen.findByText('All caught up.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Review' })).toBeInTheDocument()
  })
})

describe('Review notes', () => {
  it('shows an existing note on the review row', async () => {
    const target = queue()[0]!
    target.note = 'Check with Sam'
    renderAt('/review')
    expect(await screen.findByText('Check with Sam')).toBeInTheDocument()
  })
})
