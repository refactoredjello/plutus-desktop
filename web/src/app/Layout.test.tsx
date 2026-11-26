import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { navItems } from '@/app/router'
import { server } from '@/mocks/server'
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

  it('Refresh recalculates, then refetches every mounted query', async () => {
    const recalc = countRequests('POST', '/api/recalculate')
    const monthly = countRequests('GET', '/api/reports/monthly')
    renderAt('/')
    await waitFor(() => expect(monthly.n).toBe(1))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(recalc.n).toBe(1))
    await waitFor(() => expect(monthly.n).toBe(2))
    expect(await screen.findByRole('button', { name: 'Refresh' })).toBeEnabled()
  })

  it('shows "Refreshing..." and disables the button while it runs', async () => {
    let release = () => {}
    server.use(
      http.post('/api/recalculate', async () => {
        await new Promise<void>((resolve) => (release = resolve))
        return HttpResponse.json({ recategorized: 0, categorized: 0, recurring_changes: 0 })
      }),
    )
    renderAt('/')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByRole('button', { name: 'Refreshing...' })).toBeDisabled()
    release()
    expect(await screen.findByRole('button', { name: 'Refresh' })).toBeEnabled()
  })

  it('says what Refresh changed', async () => {
    server.use(
      http.post('/api/recalculate', () => HttpResponse.json({ recategorized: 3, categorized: 1, recurring_changes: 1 })),
    )
    renderAt('/')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await toasts().findByText('3 recategorized, 1 newly categorized, 1 recurring change')).toBeInTheDocument()
  })

  it('says everything is up to date when Refresh changed nothing', async () => {
    renderAt('/')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await toasts().findByText('Everything is up to date')).toBeInTheDocument()
  })

  it('shows a failure in a toast that stays until dismissed', async () => {
    server.use(http.post('/api/recalculate', () => HttpResponse.json({ detail: 'database is locked' }, { status: 500 })))
    const user = userEvent.setup()
    renderAt('/')
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await toasts().findByText('Refresh failed')).toBeInTheDocument()
    expect(toasts().getByText(/database is locked/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(toasts().getByRole('button', { name: 'Close toast' }))
    await waitFor(() => expect(toasts().queryByText('Refresh failed')).not.toBeInTheDocument())
  })
})
