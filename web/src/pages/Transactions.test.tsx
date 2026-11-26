import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '@/api/client'
import { server } from '@/mocks/server'
import { transactions } from '@/mocks/transactions'
import { toasts } from '@/test/motion'
import { renderAt } from '@/test/render'

/** First data row (index 0 is the header). Mock data: newest first, a pending Blue Bottle Coffee. */
async function firstRow() {
  await screen.findAllByText('Blue Bottle Coffee')
  return screen.getAllByRole('row')[1]!
}

function recordPatches(status = 200) {
  const bodies: Schemas['TransactionUpdate'][] = []
  server.use(
    http.patch('/api/transactions/:id', async ({ request, params }) => {
      bodies.push((await request.json()) as Schemas['TransactionUpdate'])
      if (status !== 200) {
        return HttpResponse.json({ title: 'Error', status, detail: 'Database unavailable' }, { status })
      }
      const txn = transactions.find((t) => t.id === Number(params.id))!
      if (bodies.at(-1)!.note !== undefined) txn.note = bodies.at(-1)!.note?.trim() || null
      const oneTime = bodies.at(-1)!.one_time
      if (oneTime != null) txn.one_time = oneTime
      if (txn.categorization) {
        txn.categorization = {
          ...txn.categorization,
          category_id: bodies.at(-1)!.category_id ?? txn.categorization.category_id,
          essentiality: bodies.at(-1)!.essentiality ?? txn.categorization.essentiality,
        }
      }
      return HttpResponse.json(txn)
    }),
  )
  return bodies
}

async function chooseCategory(row: HTMLElement, name: string) {
  const user = userEvent.setup()
  await user.click(within(row).getByRole('combobox', { name: /Category for/ }))
  await user.click(await screen.findByRole('option', { name }))
}

describe('Transactions', () => {
  it('renders rows with formatted amounts and markers', async () => {
    renderAt('/transactions')
    const row = await firstRow()
    expect(within(row).getByText('-$5.75')).toBeInTheDocument()
    expect(within(row).getByText('Pending')).toBeInTheDocument()
    expect(within(row).getByText('Rewards Visa')).toBeInTheDocument()
    expect(screen.getAllByText('+$3,150.00').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Review').length).toBeGreaterThan(0)
    expect(screen.getByText('1–50 of 120')).toBeInTheDocument()
  })

  it('shows skeleton rows while loading', () => {
    renderAt('/transactions')
    expect(screen.getAllByTestId('skeleton-row').length).toBeGreaterThan(0)
  })

  it('shows an empty state', async () => {
    renderAt('/transactions?q=zzzz')
    expect(await screen.findByText('No transactions match these filters.')).toBeInTheDocument()
  })

  it('reads filters from the URL and sends them to the API', async () => {
    const urls: URL[] = []
    server.use(
      http.get('/api/transactions', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('limit') !== '1') urls.push(url) // limit=1 is the nav badge
        return HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 })
      }),
    )
    renderAt('/transactions?q=coffee&start=2026-09-01&account=2&category=7&essentiality=flexible&review=1&transfers=1&page=2')
    await waitFor(() => expect(urls.length).toBeGreaterThan(0))
    const p = urls.at(-1)!.searchParams
    expect(p.get('q')).toBe('coffee')
    expect(p.get('start')).toBe('2026-09-01')
    expect(p.getAll('account_id')).toEqual(['2'])
    expect(p.getAll('category_id')).toEqual(['7'])
    expect(p.get('essentiality')).toBe('flexible')
    expect(p.get('needs_review')).toBe('true')
    expect(p.get('include_transfers')).toBe('true')
    expect(p.get('limit')).toBe('50')
    expect(p.get('offset')).toBe('50')
  })

  it('sends essentiality=unset and uncategorized=true from the URL', async () => {
    const urls: URL[] = []
    server.use(
      http.get('/api/transactions', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('limit') !== '1') urls.push(url) // limit=1 is the nav badge
        return HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 })
      }),
    )
    renderAt('/transactions?essentiality=unset&uncategorized=1')
    await waitFor(() => expect(urls.length).toBeGreaterThan(0))
    const p = urls.at(-1)!.searchParams
    expect(p.get('essentiality')).toBe('unset')
    expect(p.get('uncategorized')).toBe('true')
    expect(await screen.findByRole('combobox', { name: 'Essentiality filter' })).toHaveTextContent('Not set')
    expect(screen.getByRole('combobox', { name: 'Category filter' })).toHaveTextContent('No category')
  })

  it('round-trips the No category filter through the URL', async () => {
    const urls: URL[] = []
    server.use(
      http.get('/api/transactions', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('limit') !== '1') urls.push(url) // limit=1 is the nav badge
        return HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 })
      }),
    )
    const user = userEvent.setup()
    renderAt('/transactions')
    await user.click(await screen.findByRole('combobox', { name: 'Category filter' }))
    await user.type(await screen.findByPlaceholderText('Search categories'), 'no cat')
    await user.click(await screen.findByRole('option', { name: 'No category' }))
    await waitFor(() => expect(urls.at(-1)!.searchParams.get('uncategorized')).toBe('true'))
    await user.click(screen.getByRole('combobox', { name: 'Essentiality filter' }))
    await user.click(await screen.findByRole('option', { name: 'Not set' }))
    await waitFor(() => expect(urls.at(-1)!.searchParams.get('essentiality')).toBe('unset'))
    expect(urls.at(-1)!.searchParams.get('uncategorized')).toBe('true')
  })

  it('updates the request when filters change', async () => {
    const urls: URL[] = []
    server.use(
      http.get('/api/transactions', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('limit') !== '1') urls.push(url) // limit=1 is the nav badge
        return HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 })
      }),
    )
    const user = userEvent.setup()
    renderAt('/transactions')
    await user.type(await screen.findByLabelText('Search transactions'), 'netflix')
    await waitFor(() => expect(urls.at(-1)!.searchParams.get('q')).toBe('netflix'))
    await user.click(screen.getByRole('switch', { name: 'Needs review' }))
    await waitFor(() => expect(urls.at(-1)!.searchParams.get('needs_review')).toBe('true'))
    expect(urls.at(-1)!.searchParams.get('q')).toBe('netflix')
  })

  it('pages through results', async () => {
    const user = userEvent.setup()
    renderAt('/transactions')
    await screen.findByText('1–50 of 120')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('51–100 of 120')).toBeInTheDocument()
  })

  it('edits a category inline and offers to make it a rule', async () => {
    const bodies = recordPatches()
    renderAt('/transactions')
    const row = await firstRow()
    await chooseCategory(row, 'Groceries')

    expect(await within(row).findByRole('button', { name: 'Make this a rule' })).toBeInTheDocument()
    expect(bodies[0]).toMatchObject({ category_id: 7, save_as_rule: false })
    expect(within(row).getByRole('combobox', { name: /Category for/ })).toHaveTextContent('Groceries')
  })

  it('dismisses the rule offer', async () => {
    recordPatches()
    const user = userEvent.setup()
    renderAt('/transactions')
    const row = await firstRow()
    await chooseCategory(row, 'Groceries')
    await user.click(await within(row).findByRole('button', { name: 'Dismiss' }))
    expect(within(row).queryByText('Make this a rule')).not.toBeInTheDocument()
  })

  it('filters categories by label or group, and selects with the keyboard', async () => {
    const bodies = recordPatches()
    const user = userEvent.setup()
    renderAt('/transactions')
    const row = await firstRow()
    const trigger = within(row).getByRole('combobox', { name: /Category for/ })
    await user.click(trigger)
    const search = await screen.findByPlaceholderText('Search categories')
    expect(search).toHaveFocus()

    await user.type(search, 'FOOD')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['Coffee', 'Groceries', 'Restaurant', 'Fast food']),
    )
    expect(screen.queryByRole('option', { name: 'Rent' })).not.toBeInTheDocument()

    await user.clear(search)
    await user.type(search, 'grocer')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(bodies[0]).toMatchObject({ category_id: 7, save_as_rule: false }))
  })

  it('shows an empty state when nothing matches', async () => {
    const user = userEvent.setup()
    renderAt('/transactions')
    const row = await firstRow()
    await user.click(within(row).getByRole('combobox', { name: /Category for/ }))
    await user.type(await screen.findByPlaceholderText('Search categories'), 'zzzz')
    expect(await screen.findByText('No matching categories')).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByPlaceholderText('Search categories')).not.toBeInTheDocument())
    expect(within(row).getByRole('combobox', { name: /Category for/ })).toHaveFocus()
  })

  it('edits essentiality inline', async () => {
    const bodies = recordPatches()
    const user = userEvent.setup()
    renderAt('/transactions')
    const row = await firstRow()
    await user.click(within(row).getByRole('combobox', { name: /Essentiality for/ }))
    await user.click(await screen.findByRole('option', { name: 'Essential' }))
    await waitFor(() => expect(bodies[0]).toMatchObject({ essentiality: 'essential' }))
  })

  it('confirms a category change by the control alone, with no toast', async () => {
    const bodies = recordPatches()
    renderAt('/transactions')
    const row = await firstRow()
    await chooseCategory(row, 'Groceries')
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(await within(row).findByText('Make this a rule')).toBeInTheDocument()
    expect(within(row).getByRole('combobox', { name: /Category for/ })).toHaveTextContent('Groceries')
    expect(toasts().queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('rolls back the optimistic update when the save fails', async () => {
    recordPatches(500)
    renderAt('/transactions')
    const row = await firstRow()
    const trigger = within(row).getByRole('combobox', { name: /Category for/ })
    expect(trigger).toHaveTextContent('Coffee')

    await chooseCategory(row, 'Groceries')

    expect(await toasts().findByText('Could not save')).toBeInTheDocument()
    expect(toasts().getByText('Database unavailable')).toBeInTheDocument()
    expect(within(row).queryByRole('alert')).not.toBeInTheDocument()
    expect(trigger).toHaveTextContent('Coffee')
    expect(within(row).queryByText('Make this a rule')).not.toBeInTheDocument()
  })
})

describe('Transaction notes', () => {
  async function openEditor(name: RegExp) {
    const user = userEvent.setup()
    const row = await firstRow()
    await user.click(within(row).getByRole('button', { name }))
    return { user, row, box: await screen.findByRole('textbox', { name: /^Note for/ }) }
  }

  it('adds a note with a PATCH of exactly { note } and shows it', async () => {
    const bodies = recordPatches()
    renderAt('/transactions')
    const { user, row, box } = await openEditor(/Add note for Blue Bottle Coffee/)
    await user.type(box, '  Team coffee  ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(bodies).toEqual([{ note: 'Team coffee' }]))
    expect(await within(row).findByText('Team coffee')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: /Edit note for Blue Bottle Coffee/ })).toBeInTheDocument()
  })

  it('saves with Ctrl+Enter and cancels with Escape', async () => {
    const bodies = recordPatches()
    renderAt('/transactions')
    const first = await openEditor(/Add note for/)
    await first.user.type(first.box, 'dropped')
    await first.user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /^Note for/ })).not.toBeInTheDocument())
    expect(bodies).toHaveLength(0)

    const second = await openEditor(/Add note for/)
    await second.user.type(second.box, 'kept')
    await second.user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(bodies).toEqual([{ note: 'kept' }]))
  })

  it('edits and clears an existing note', async () => {
    transactions.find((t) => t.id === 1000)!.note = 'Old note'
    const bodies = recordPatches()
    renderAt('/transactions')
    const { user, row, box } = await openEditor(/Edit note for Blue Bottle Coffee/)
    expect(box).toHaveValue('Old note')
    await user.clear(box)
    await user.type(box, 'New note')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(bodies).toEqual([{ note: 'New note' }]))
    expect(await within(row).findByText('New note')).toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: /Edit note for/ }))
    await user.click(await screen.findByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(bodies.at(-1)).toEqual({ note: null }))
    await waitFor(() => expect(within(row).queryByText('New note')).not.toBeInTheDocument())
    expect(within(row).getByRole('button', { name: /Add note for/ })).toBeInTheDocument()
  })

  it('has a search placeholder that mentions notes, and search finds notes', async () => {
    transactions.find((t) => t.id === 999)!.note = 'birthday surprise'
    const user = userEvent.setup()
    renderAt('/transactions')
    const box = await screen.findByPlaceholderText('Search descriptions and notes')
    await user.type(box, 'birthday')
    // A 300 ms debounce, a refetch, and a re-render of the page: slow CI runners need more than the 1 s default.
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2), { timeout: 3000 })
    expect(screen.getByText('birthday surprise')).toBeInTheDocument()
  })
})

describe('One-time expenses', () => {
  it('toggles with a PATCH of exactly { one_time } and shows a badge', async () => {
    const bodies = recordPatches()
    renderAt('/transactions')
    const user = userEvent.setup()
    const row = await firstRow()
    await user.click(within(row).getByRole('button', { name: /Mark Blue Bottle Coffee as one-time/ }))
    await waitFor(() => expect(bodies).toEqual([{ one_time: true }]))
    expect(await within(row).findByText('One-time')).toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: /Unmark Blue Bottle Coffee as one-time/ }))
    await waitFor(() => expect(bodies).toEqual([{ one_time: true }, { one_time: false }]))
    await waitFor(() => expect(within(row).queryByText('One-time')).not.toBeInTheDocument())
  })
})

describe('Clear filters', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is absent when no filter is set', async () => {
    renderAt('/transactions')
    await firstRow()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
  })

  it('appears in the top row for filters from the URL and clears every filter', async () => {
    const urls: URL[] = []
    server.use(
      http.get('/api/transactions', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('limit') !== '1') urls.push(url) // limit=1 is the nav badge
        return HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 })
      }),
    )
    const user = userEvent.setup()
    const { router } = renderAt(
      '/transactions?q=coffee&start=2026-09-01&end=2026-09-30&account=2&category=7&essentiality=flexible&review=1&transfers=1&page=2',
    )
    const button = await screen.findByRole('button', { name: 'Clear filters' })
    const topRow = screen.getByLabelText('Search transactions').parentElement!
    expect(topRow).toContainElement(button)
    expect(topRow).toContainElement(screen.getByRole('combobox', { name: 'Essentiality filter' }))

    await user.click(button)
    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(screen.getByLabelText('Search transactions')).toHaveValue('')
    expect(screen.getByLabelText('From date')).toHaveValue('')
    expect(screen.getByLabelText('To date')).toHaveValue('')
    expect(screen.getByRole('switch', { name: 'Needs review' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Include transfers' })).not.toBeChecked()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
    await waitFor(() => expect(urls.at(-1)!.searchParams.get('offset')).toBe('0'))
    const p = urls.at(-1)!.searchParams
    for (const key of ['q', 'start', 'end', 'account_id', 'category_id', 'essentiality', 'needs_review', 'include_transfers']) {
      expect(p.has(key)).toBe(false)
    }
  })

  it('appears for the uncategorized filter alone', async () => {
    renderAt('/transactions?uncategorized=1')
    expect(await screen.findByRole('button', { name: 'Clear filters' })).toBeInTheDocument()
  })

  it('discards a pending search so typed text is not re-applied after clearing', async () => {
    const { router } = renderAt('/transactions?review=1')
    await screen.findByRole('button', { name: 'Clear filters' })
    // Only the debounce timer is faked; userEvent's async wrapper would wait on a faked timer.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const box = screen.getByLabelText('Search transactions')
    fireEvent.change(box, { target: { value: 'netflix' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(box).toHaveValue('')
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(box).toHaveValue('')
    expect(router.state.location.search).toBe('')
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
  })

  it('appears while a search is still pending, before the debounce fires', async () => {
    renderAt('/transactions')
    await firstRow()
    // Only the debounce timer is faked; userEvent's async wrapper would wait on a faked timer.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const box = screen.getByLabelText('Search transactions')
    fireEvent.change(box, { target: { value: 'net' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(box).toHaveValue('')
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(box).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
  })
})
