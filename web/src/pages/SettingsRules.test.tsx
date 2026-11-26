import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '@/api/client'
import { requestsInLastDay } from '@/features/sync/requests'
import { rules } from '@/mocks/rules'
import { settingsState } from '@/mocks/settings'
import { server } from '@/mocks/server'
import { toasts } from '@/test/motion'
import { renderAt } from '@/test/render'

describe('Settings: rules', () => {
  it('lists rules with category labels and deletes after confirming', async () => {
    const user = userEvent.setup()
    renderAt('/settings')
    const row = (await screen.findByText('NETFLIX.COM CA')).closest('tr')!
    expect(await within(row).findByText('TV and movies')).toBeInTheDocument()
    expect(within(row).getByText('Discretionary')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete rule for NETFLIX.COM CA' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('NETFLIX.COM CA')).not.toBeInTheDocument())
    expect(rules).toHaveLength(2)
    expect(await toasts().findByText('Rule deleted')).toBeInTheDocument()
  })

  it('words every match type in plain language', async () => {
    renderAt('/settings')
    const text = (pattern: string) => screen.findByText(pattern).then((el) => el.closest('tr')!.textContent)
    expect(await text('NETFLIX.COM CA')).toMatch(/^isNETFLIX\.COM CA/)
    expect(await text('SHELL OIL')).toMatch(/^starts withSHELL OIL/)
    expect(await text('PAYPAL INST XFER JANEDOE')).toMatch(/^description containsPAYPAL INST XFER JANEDOE/)
  })

  it('explains where rules come from when there are none', async () => {
    server.use(http.get('/api/rules', () => HttpResponse.json([])))
    renderAt('/settings')
    expect(await screen.findByText(/open any transaction and create one in its Rule section/)).toBeInTheDocument()
  })

  it('refreshes transactions after deleting a rule', async () => {
    const user = userEvent.setup()
    const fetches = countTransactionFetches()
    renderAt('/settings')
    await user.click(await screen.findByRole('button', { name: 'Delete rule for SHELL OIL' }))
    await waitFor(() => expect(fetches.count).toBeGreaterThan(0))
    const before = fetches.count
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(fetches.count).toBeGreaterThan(before))
  })
})

/** Counts GET /api/transactions (the nav badge keeps one active query on every page). */
function countTransactionFetches() {
  const fetches = { count: 0 }
  server.use(
    http.get('/api/transactions', () => {
      fetches.count += 1
      return undefined
    }),
  )
  return fetches
}

describe('Settings: new rule', () => {
  function recordRulePosts() {
    const bodies: Schemas['RuleCreate'][] = []
    server.use(
      http.post('/api/rules', async ({ request }) => {
        bodies.push((await request.clone().json()) as Schemas['RuleCreate']) // the mock reads the original
        return undefined
      }),
    )
    return bodies
  }

  async function openDialog() {
    const user = userEvent.setup()
    renderAt('/settings')
    await screen.findByText('NETFLIX.COM CA')
    await user.click(screen.getByRole('button', { name: 'New rule' }))
    return { user, dialog: await screen.findByRole('dialog', { name: 'New rule' }) }
  }

  it('creates a rule with a match type, pattern, category, and essentiality', async () => {
    const bodies = recordRulePosts()
    const fetches = countTransactionFetches()
    const { user, dialog } = await openDialog()
    const create = within(dialog).getByRole('button', { name: 'Create rule' })
    expect(create).toBeDisabled()

    const matchType = within(dialog).getByRole('combobox', { name: 'Match type' })
    expect(matchType).toHaveTextContent('Merchant is')
    await user.click(matchType)
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
      'Merchant is',
      'Merchant starts with',
      'Bank description contains',
    ])
    await user.click(screen.getByRole('option', { name: 'Merchant starts with' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'Pattern' }), 'uber')
    expect(await within(dialog).findByText('Matches 0 transactions.')).toBeInTheDocument()
    expect(create).toBeDisabled() // no category yet
    await user.click(within(dialog).getByRole('combobox', { name: 'Category' }))
    await user.click(await screen.findByRole('option', { name: 'Public transit' }))
    await user.click(within(dialog).getByRole('combobox', { name: 'Essentiality' }))
    await user.click(await screen.findByRole('option', { name: 'Flexible' }))
    const before = fetches.count
    await user.click(create)

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ match_type: 'prefix', pattern: 'uber', category_id: 13, essentiality: 'flexible' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const row = (await screen.findByText('UBER')).closest('tr')!
    expect(row.textContent).toMatch(/^starts withUBER/)
    expect(within(row).getByText('Public transit')).toBeInTheDocument()
    await waitFor(() => expect(fetches.count).toBeGreaterThan(before))
    expect(await toasts().findByText('Rule created')).toBeInTheDocument()
  })

  it('sends no essentiality after choosing "Not set"', async () => {
    const bodies = recordRulePosts()
    const { user, dialog } = await openDialog()
    await user.type(within(dialog).getByRole('textbox', { name: 'Pattern' }), 'netflix')
    await user.click(within(dialog).getByRole('combobox', { name: 'Category' }))
    await user.click(await screen.findByRole('option', { name: 'TV and movies' }))
    const essentiality = within(dialog).getByRole('combobox', { name: 'Essentiality' })
    await user.click(essentiality)
    await user.click(await screen.findByRole('option', { name: 'Discretionary' }))
    await user.click(essentiality)
    await user.click(await screen.findByRole('option', { name: 'Not set' }))
    expect(essentiality).toHaveTextContent('Not set')
    await user.click(within(dialog).getByRole('button', { name: 'Create rule' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ match_type: 'exact', pattern: 'netflix', category_id: 10 })
  })

  it('leaves essentiality out when not chosen, and shows a server error', async () => {
    const bodies: unknown[] = []
    server.use(
      http.post('/api/rules', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ title: 'Bad Request', status: 400, detail: 'Rule pattern must not be empty' }, { status: 400 })
      }),
    )
    const { user, dialog } = await openDialog()
    await user.type(within(dialog).getByRole('textbox', { name: 'Pattern' }), 'Paypal')
    await user.click(within(dialog).getByRole('combobox', { name: 'Category' }))
    await user.click(await screen.findByRole('option', { name: 'Coffee' }))
    await user.click(within(dialog).getByRole('button', { name: 'Create rule' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Rule pattern must not be empty')
    expect(bodies[0]).toEqual({ match_type: 'exact', pattern: 'Paypal', category_id: 6 })
  })
})

describe('Settings: edit rule', () => {
  function recordRulePatches() {
    const calls: { id: string; body: unknown }[] = []
    server.use(
      http.patch('/api/rules/:id', async ({ params, request }) => {
        calls.push({ id: String(params.id), body: await request.clone().json() }) // the mock reads the original
        return undefined
      }),
    )
    return calls
  }

  async function openEdit(pattern: string) {
    const user = userEvent.setup()
    renderAt('/settings')
    await screen.findByText(pattern)
    await user.click(screen.getByRole('button', { name: `Edit rule for ${pattern}` }))
    return { user, dialog: await screen.findByRole('dialog', { name: 'Edit rule' }) }
  }

  it('opens the dialog prefilled with the rule', async () => {
    const { dialog } = await openEdit('NETFLIX.COM CA')
    expect(within(dialog).getByRole('combobox', { name: 'Match type' })).toHaveTextContent('Merchant is')
    expect(within(dialog).getByRole('textbox', { name: 'Pattern' })).toHaveValue('NETFLIX.COM CA')
    expect(within(dialog).getByRole('combobox', { name: 'Category' })).toHaveTextContent('TV and movies')
    expect(within(dialog).getByRole('combobox', { name: 'Essentiality' })).toHaveTextContent('Discretionary')
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('sends the edited rule with PATCH, updates the row, and refreshes transactions', async () => {
    const calls = recordRulePatches()
    const fetches = countTransactionFetches()
    const { user, dialog } = await openEdit('SHELL OIL')
    expect(within(dialog).getByRole('combobox', { name: 'Essentiality' })).toHaveTextContent('Not set')
    await user.click(within(dialog).getByRole('combobox', { name: 'Match type' }))
    await user.click(await screen.findByRole('option', { name: 'Merchant is' }))
    const pattern = within(dialog).getByRole('textbox', { name: 'Pattern' })
    await user.clear(pattern)
    await user.type(pattern, 'shell oil 57442')
    await user.click(within(dialog).getByRole('combobox', { name: 'Category' }))
    await user.click(await screen.findByRole('option', { name: 'Public transit' }))
    await user.click(within(dialog).getByRole('combobox', { name: 'Essentiality' }))
    await user.click(await screen.findByRole('option', { name: 'Essential' }))
    const before = fetches.count
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({
      id: '2',
      body: { match_type: 'exact', pattern: 'shell oil 57442', category_id: 13, essentiality: 'essential' },
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const row = (await screen.findByText('SHELL OIL 57442')).closest('tr')!
    expect(row.textContent).toMatch(/^isSHELL OIL 57442/)
    expect(within(row).getByText('Public transit')).toBeInTheDocument()
    expect(within(row).getByText('Essential')).toBeInTheDocument()
    expect(screen.queryByText('SHELL OIL')).not.toBeInTheDocument()
    expect(rules).toHaveLength(3)
    await waitFor(() => expect(fetches.count).toBeGreaterThan(before))
    expect(await toasts().findByText('Rule updated')).toBeInTheDocument()
  })

  it('clears essentiality with an explicit null after choosing "Not set"', async () => {
    const calls = recordRulePatches()
    const { user, dialog } = await openEdit('NETFLIX.COM CA')
    await user.click(within(dialog).getByRole('combobox', { name: 'Essentiality' }))
    await user.click(await screen.findByRole('option', { name: 'Not set' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.body).toEqual({ match_type: 'exact', pattern: 'NETFLIX.COM CA', category_id: 10, essentiality: null })
  })

  it('shows a server error inline and keeps the dialog open', async () => {
    const { user, dialog } = await openEdit('SHELL OIL')
    await user.click(within(dialog).getByRole('combobox', { name: 'Match type' }))
    await user.click(await screen.findByRole('option', { name: 'Merchant is' }))
    const pattern = within(dialog).getByRole('textbox', { name: 'Pattern' })
    await user.clear(pattern)
    await user.type(pattern, 'netflix.com ca')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A rule with this match already exists')
    expect(screen.getByRole('dialog', { name: 'Edit rule' })).toBeInTheDocument()
  })
})

describe('Settings: SimpleFIN requests', () => {
  it('sums requests from runs started in the last 24 hours', () => {
    const now = Date.parse('2026-10-03T12:00:00Z')
    const runs = [
      { started_at: '2026-10-03T06:00:00Z', requests: 2 },
      { started_at: '2026-10-02T13:00:00Z', requests: 3 },
      { started_at: '2026-10-02T11:00:00Z', requests: 9 },
    ]
    expect(requestsInLastDay(runs, now)).toBe(5)
  })

  it('shows the used count against the daily budget', async () => {
    const recent = new Date(Date.now() - 3_600_000).toISOString()
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const run = { provider: 'simplefin', trigger: 'manual', status: 'success', finished_at: recent, added: 0, updated: 0, error_text: null } as const
    server.use(
      http.get('/api/sync/runs', () =>
        HttpResponse.json([
          { ...run, id: 2, started_at: recent, requests: 3 },
          { ...run, id: 1, started_at: old, requests: 5 },
        ]),
      ),
    )
    renderAt('/settings')
    expect(await screen.findByText('SimpleFIN requests in the last 24 hours: 3 of 24')).toBeInTheDocument()
  })
})


describe('Settings: next scheduled sync', () => {
  it('shows when the next scheduled sync runs and how often', async () => {
    settingsState.simplefin = { connected: true, connected_at: new Date().toISOString() }
    renderAt('/settings')
    const line = await screen.findByText(/Next scheduled sync:/)
    expect(line).toHaveTextContent('in 3 hours')
    expect(line).toHaveTextContent('every 6 hours')
  })

  it('explains that scheduled syncs wait for a bank connection', async () => {
    renderAt('/settings')
    expect(await screen.findByText('Scheduled syncs start after you connect a bank.')).toBeInTheDocument()
  })

  it('says when scheduled syncs are off', async () => {
    server.use(
      http.get('/api/sync/schedule', () =>
        HttpResponse.json({ enabled: false, interval_hours: 6, next_run_at: null }),
      ),
    )
    renderAt('/settings')
    expect(await screen.findByText('Scheduled syncs are off.')).toBeInTheDocument()
  })
})
