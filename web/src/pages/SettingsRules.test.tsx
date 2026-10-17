import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { requestsInLastDay } from '@/features/settings/requests'
import { rules } from '@/mocks/rules'
import { settingsState } from '@/mocks/settings'
import { server } from '@/mocks/server'
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
    expect(await screen.findByText(/choose "Apply to all"/)).toBeInTheDocument()
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
