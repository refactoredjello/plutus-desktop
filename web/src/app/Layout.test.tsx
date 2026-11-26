import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { navItems } from '@/app/router'
import { server } from '@/mocks/server'
import { settingsState } from '@/mocks/settings'
import { runs } from '@/mocks/sync'
import { toasts } from '@/test/motion'
import { renderAt } from '@/test/render'

/** Count requests whose method and path match, from now on. */
function countRequests(method: string, path: string) {
  const seen = { n: 0 }
  server.events.on('request:start', ({ request }) => {
    if (request.method === method && new URL(request.url).pathname === path) seen.n += 1
  })
  return seen
}

afterEach(() => server.events.removeAllListeners())

describe('Layout', () => {
  it('shows every navigation item', () => {
    renderAt('/')
    for (const item of navItems) {
      expect(screen.getByRole('link', { name: new RegExp(`^${item.label}`) })).toBeInTheDocument()
    }
  })

  it('renders the overview page at the root route', () => {
    renderAt('/')
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
  })

  it('Recalculate recalculates, then refetches every mounted query', async () => {
    const recalc = countRequests('POST', '/api/recalculate')
    const monthly = countRequests('GET', '/api/reports/monthly')
    renderAt('/')
    await waitFor(() => expect(monthly.n).toBe(1))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Recalc' }))
    await waitFor(() => expect(recalc.n).toBe(1))
    await waitFor(() => expect(monthly.n).toBe(2))
    expect(await screen.findByRole('button', { name: 'Recalc' })).toBeEnabled()
  })

  it('shows "Recalculating..." and disables the button while it runs', async () => {
    let release = () => {}
    server.use(
      http.post('/api/recalculate', async () => {
        await new Promise<void>((resolve) => (release = resolve))
        return HttpResponse.json({ recategorized: 0, categorized: 0, recurring_changes: 0 })
      }),
    )
    renderAt('/')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Recalc' }))
    expect(await screen.findByRole('button', { name: 'Recalculating...' })).toBeDisabled()
    release()
    expect(await screen.findByRole('button', { name: 'Recalc' })).toBeEnabled()
  })

  it('says what Recalculate changed', async () => {
    server.use(
      http.post('/api/recalculate', () => HttpResponse.json({ recategorized: 3, categorized: 1, recurring_changes: 1 })),
    )
    renderAt('/')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Recalc' }))
    expect(await toasts().findByText('3 recategorized, 1 newly categorized, 1 recurring change')).toBeInTheDocument()
  })

  it('says everything is up to date when Recalculate changed nothing', async () => {
    renderAt('/')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Recalc' }))
    expect(await toasts().findByText('Everything is up to date')).toBeInTheDocument()
  })

  it('shows a failure in a toast that stays until dismissed', async () => {
    server.use(http.post('/api/recalculate', () => HttpResponse.json({ detail: 'database is locked' }, { status: 500 })))
    const user = userEvent.setup()
    renderAt('/')
    await user.click(screen.getByRole('button', { name: 'Recalc' }))
    expect(await toasts().findByText('Recalc failed')).toBeInTheDocument()
    expect(toasts().getByText(/database is locked/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(toasts().getByRole('button', { name: 'Close toast' }))
    await waitFor(() => expect(toasts().queryByText('Recalc failed')).not.toBeInTheDocument())
  })

  it('says Recalculate is local only', async () => {
    renderAt('/')
    expect(await screen.findByRole('button', { name: 'Recalc' })).toHaveAttribute(
      'title',
      expect.stringMatching(/does not contact the bank/i),
    )
  })
})

const connect = () => {
  settingsState.simplefin = { connected: true, connected_at: '2026-09-01T12:00:00Z' }
}

describe('Header sync', () => {
  it('is disabled with a hint when no bank is connected', async () => {
    renderAt('/')
    const sync = await screen.findByRole('button', { name: 'Sync' })
    await waitFor(() => expect(sync).toHaveAttribute('title', 'Connect a bank in Settings'))
    expect(sync).toBeDisabled()
  })

  it('is disabled when the daily request budget is used up', async () => {
    connect()
    const now = new Date().toISOString()
    runs.unshift(
      ...Array.from({ length: 24 }, (_, i) => ({ ...runs[0]!, id: 100 + i, started_at: now, finished_at: now, requests: 1 })),
    )
    renderAt('/')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sync' })).toHaveAttribute('title', expect.stringMatching(/24 of 24/)),
    )
    expect(screen.getByRole('button', { name: 'Sync' })).toBeDisabled()
  })

  it('pulls from the bank, then recalculates and refetches, with one summary toast', async () => {
    connect()
    server.use(
      http.post('/api/recalculate', () => HttpResponse.json({ recategorized: 2, categorized: 0, recurring_changes: 0 })),
    )
    const recalc = countRequests('POST', '/api/recalculate')
    const monthly = countRequests('GET', '/api/reports/monthly')
    renderAt('/')
    await waitFor(() => expect(monthly.n).toBe(1))
    const sync = await screen.findByRole('button', { name: 'Sync' })
    expect(sync).toHaveAttribute('title', expect.stringMatching(/contacts your bank/i))
    await waitFor(() => expect(sync).toBeEnabled())
    await userEvent.setup().click(sync)

    expect(await screen.findByRole('button', { name: 'Syncing...' })).toBeDisabled()
    expect(recalc.n).toBe(0)
    // The mock run finishes on its second poll, 2s after the first.
    expect(await toasts().findByText('Synced: 4 new, 1 updated; 2 recategorized', {}, { timeout: 8000 })).toBeInTheDocument()
    expect(recalc.n).toBe(1)
    await waitFor(() => expect(monthly.n).toBe(2))
    expect(await screen.findByRole('button', { name: 'Sync' })).toBeEnabled()
    expect(await screen.findByText('Synced just now')).toBeInTheDocument()
  }, 15000)

  it('says when a sync found nothing new', async () => {
    connect()
    server.use(
      http.get('/api/sync/runs/:id', ({ params }) => {
        const run = runs.find((r) => r.id === Number(params.id))!
        Object.assign(run, { status: 'success', finished_at: new Date().toISOString(), added: 0, updated: 0 })
        return HttpResponse.json(run)
      }),
    )
    renderAt('/')
    const sync = await screen.findByRole('button', { name: 'Sync' })
    await waitFor(() => expect(sync).toBeEnabled())
    await userEvent.setup().click(sync)
    expect(await toasts().findByText('Synced: nothing new', {}, { timeout: 8000 })).toBeInTheDocument()
  }, 15000)

  it('toasts a failed run with its error and does not recalculate', async () => {
    connect()
    server.use(
      http.get('/api/sync/runs/:id', ({ params }) => {
        const run = runs.find((r) => r.id === Number(params.id))!
        Object.assign(run, { status: 'error', finished_at: new Date().toISOString(), error_text: 'SimpleFIN said no' })
        return HttpResponse.json(run)
      }),
    )
    const recalc = countRequests('POST', '/api/recalculate')
    renderAt('/')
    const sync = await screen.findByRole('button', { name: 'Sync' })
    await waitFor(() => expect(sync).toBeEnabled())
    await userEvent.setup().click(sync)
    expect(await toasts().findByText('Sync failed', {}, { timeout: 8000 })).toBeInTheDocument()
    expect(toasts().getByText('SimpleFIN said no')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Sync' })).toBeEnabled()
    expect(recalc.n).toBe(0)
  }, 15000)

  it('toasts a rejected start', async () => {
    connect()
    server.use(
      http.post('/api/sync', () =>
        HttpResponse.json({ title: 'Conflict', status: 409, detail: 'A sync is already running' }, { status: 409 }),
      ),
    )
    renderAt('/')
    const sync = await screen.findByRole('button', { name: 'Sync' })
    await waitFor(() => expect(sync).toBeEnabled())
    await userEvent.setup().click(sync)
    expect(await toasts().findByText('Sync failed')).toBeInTheDocument()
    expect(toasts().getByText(/A sync is already running/)).toBeInTheDocument()
  })

  it('shows when the last successful sync was, with the full time on hover', async () => {
    runs[0]!.finished_at = new Date(Date.now() - 2 * 3600_000).toISOString()
    renderAt('/')
    const line = await screen.findByText('Synced 2 hours ago')
    expect(line).toHaveAttribute('title', expect.stringMatching(/\d{4}/))
  })

  it('says "Never synced" when no sync has succeeded', async () => {
    server.use(http.get('/api/sync/runs', () => HttpResponse.json([])))
    renderAt('/')
    expect(await screen.findByText('Never synced')).toBeInTheDocument()
  })

  it('refetches the views when a sync finishes in the background', async () => {
    let list = runs.slice()
    server.use(http.get('/api/sync/runs', () => HttpResponse.json(list)))
    const monthly = countRequests('GET', '/api/reports/monthly')
    const { queryClient } = renderAt('/')
    await waitFor(() => expect(monthly.n).toBe(1))
    await screen.findByText(/^Synced /)
    const now = new Date().toISOString()
    list = [{ ...runs[0]!, id: 50, trigger: 'scheduled', started_at: now, finished_at: now }, ...runs]
    // What the header's minute refetch of the runs would see.
    await queryClient.refetchQueries({ queryKey: ['sync', 'runs'] })
    await waitFor(() => expect(monthly.n).toBeGreaterThanOrEqual(2))
  })
})

