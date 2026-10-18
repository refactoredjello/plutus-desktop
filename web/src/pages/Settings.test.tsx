import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { settingsState } from '@/mocks/settings'
import { server } from '@/mocks/server'
import { renderAt } from '@/test/render'

const connect = () => {
  settingsState.simplefin = { connected: true, connected_at: '2026-09-01T12:00:00Z' }
}

describe('Settings', () => {
  it('connects a bank with a setup token', async () => {
    const user = userEvent.setup()
    renderAt('/settings')

    const syncNow = await screen.findByRole('button', { name: 'Sync now' })
    expect(syncNow).toBeDisabled()

    await user.type(await screen.findByLabelText('SimpleFIN setup token'), 'secret-token')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByText(/Connected since/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled())
  })

  it('disconnects after confirming', async () => {
    connect()
    const user = userEvent.setup()
    renderAt('/settings')

    await user.click(await screen.findByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }))

    expect(await screen.findByLabelText('SimpleFIN setup token')).toBeInTheDocument()
  })

  it('runs a sync, polls until it finishes, and updates history', async () => {
    connect()
    const user = userEvent.setup()
    renderAt('/settings')

    await screen.findByText('Bank connection timed out')
    await user.click(await screen.findByRole('button', { name: 'Sync now' }))

    expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeDisabled()
    // Mock completes on the second poll, 2s after the first.
    expect(await screen.findByRole('button', { name: 'Sync now' }, { timeout: 8000 })).toBeEnabled()
    const rows = await screen.findAllByRole('row')
    expect(within(rows[1]!).getByText('success')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('4')).toBeInTheDocument()
  }, 15000)

  it('shows the API detail when a sync is rejected', async () => {
    connect()
    server.use(
      http.post('/api/sync', () =>
        HttpResponse.json({ title: 'Conflict', status: 409, detail: 'A sync is already running' }, { status: 409 }),
      ),
    )
    const user = userEvent.setup()
    renderAt('/settings')

    await user.click(await screen.findByRole('button', { name: 'Sync now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A sync is already running')
  })

  it('lists accounts, the LLM status, and sync history', async () => {
    renderAt('/settings')
    expect(await screen.findByText('Everyday Checking')).toBeInTheDocument()
    expect(screen.getByText('$4,821.17')).toBeInTheDocument()
    expect(await screen.findByText(/claude-haiku-4-5/)).toBeInTheDocument()
    expect(await screen.findByText('success')).toBeInTheDocument()
  })

  it('warns when the LLM is not configured', async () => {
    server.use(
      http.get('/api/settings/llm', () => HttpResponse.json({ provider: 'anthropic', model: 'none', configured: false })),
    )
    renderAt('/settings')
    expect(await screen.findByText('Not configured')).toBeInTheDocument()
  })

  it('hides a category and adds a custom one', async () => {
    const user = userEvent.setup()
    renderAt('/settings')

    await user.click(await screen.findByRole('button', { name: /Food and drink/ }))
    await user.click(await screen.findByRole('switch', { name: 'Show Coffee' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Show Coffee' })).not.toBeChecked())

    await user.click(screen.getByRole('combobox', { name: 'New category group' }))
    await user.click(await screen.findByRole('option', { name: 'Food and drink' }))
    await user.type(screen.getByLabelText('New category name'), 'Bakery')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByLabelText('Rename Bakery')).toBeInTheDocument()
  })
})

describe('Settings dismissed changes', () => {
  it('clears dismissals with DELETE and confirms inline', async () => {
    let called = false
    server.use(
      http.delete('/api/reports/changes/dismissals', () => {
        called = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    renderAt('/settings')
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Clear dismissed changes' }))
    expect(await screen.findByText('Cleared')).toBeInTheDocument()
    expect(called).toBe(true)
  })
})

describe('Settings app version', () => {
  it('shows the version the server reports', async () => {
    server.use(http.get('/api/health', () => HttpResponse.json({ status: 'ok', database: 'ok', version: '0.2.0' })))
    renderAt('/settings')
    expect(await screen.findByText('Plutus 0.2.0')).toBeInTheDocument()
  })
})
