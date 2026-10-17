import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/mocks/server'
import { settingsState } from '@/mocks/settings'
import { renderAt } from '@/test/render'

/** The config card, once its data has loaded. */
async function card() {
  const region = await screen.findByRole('region', { name: 'Configuration' })
  await within(region).findByDisplayValue('claude-haiku-4-5')
  return region
}

const save = (c: HTMLElement) => within(c).getByRole('button', { name: 'Save configuration' })

describe('ConfigCard', () => {
  it('shows the current config, with the API key only as set or not set', async () => {
    renderAt('/settings')
    const c = await card()

    expect(within(c).getByRole('combobox', { name: 'LLM provider' })).toHaveTextContent('Claude')
    expect(within(c).getByLabelText('Model')).toHaveValue('claude-haiku-4-5')
    expect(within(c).getByText('Set')).toBeInTheDocument()
    const key = within(c).getByLabelText('New Anthropic API key')
    expect(key).toHaveValue('')
    expect(key).toHaveAttribute('type', 'password')
    expect(within(c).getByText('ALEX')).toBeInTheDocument()
    expect(within(c).getByText('SAMPLE')).toBeInTheDocument()
    expect(within(c).getByLabelText('Sync every (hours)')).toHaveValue(6)
    expect(within(c).getByLabelText('First sync history (days)')).toHaveValue(180)
    expect(within(c).getByRole('switch', { name: 'Sync automatically' })).toBeChecked()
    // The Ollama URL only matters for Ollama.
    expect(within(c).queryByLabelText('Ollama URL')).not.toBeInTheDocument()
    expect(save(c)).toBeDisabled()
  })

  it('saves only the fields that changed', async () => {
    const user = userEvent.setup()
    renderAt('/settings')
    const c = await card()

    const model = within(c).getByLabelText('Model')
    await user.clear(model)
    await user.type(model, 'claude-sonnet-4-5')
    const hours = within(c).getByLabelText('Sync every (hours)')
    await user.clear(hours)
    await user.type(hours, '12')
    await user.click(within(c).getByRole('switch', { name: 'Sync automatically' }))
    await user.click(save(c))

    expect(await within(c).findByText('Saved')).toBeInTheDocument()
    expect(settingsState.configUpdates).toEqual([
      { llm_model: 'claude-sonnet-4-5', sync_interval_hours: 12, scheduler_enabled: false },
    ])
    expect(within(c).getByLabelText('Model')).toHaveValue('claude-sonnet-4-5')
    expect(within(c).getByLabelText('Sync every (hours)')).toHaveValue(12)
    expect(within(c).getByRole('switch', { name: 'Sync automatically' })).not.toBeChecked()
    expect(save(c)).toBeDisabled()
  })

  it('sets a new API key and forgets it after saving', async () => {
    settingsState.config = { ...settingsState.config, anthropic_api_key_set: false }
    const user = userEvent.setup()
    renderAt('/settings')
    const c = await card()

    expect(within(c).getByText('Not set')).toBeInTheDocument()
    await user.type(within(c).getByLabelText('New Anthropic API key'), 'fake-key-123')
    await user.click(save(c))

    expect(await within(c).findByText('Set')).toBeInTheDocument()
    expect(settingsState.configUpdates).toEqual([{ anthropic_api_key: 'fake-key-123' }])
    expect(within(c).getByLabelText('New Anthropic API key')).toHaveValue('')
    expect(within(c).queryByDisplayValue('fake-key-123')).not.toBeInTheDocument()
  })

  it('clears the API key with null', async () => {
    const user = userEvent.setup()
    renderAt('/settings')
    const c = await card()

    await user.click(within(c).getByRole('button', { name: 'Clear key' }))
    await user.click(save(c))

    expect(await within(c).findByText('Not set')).toBeInTheDocument()
    expect(settingsState.configUpdates).toEqual([{ anthropic_api_key: null }])
  })

  it('adds and removes owner name tokens as chips', async () => {
    const user = userEvent.setup()
    renderAt('/settings')
    const c = await card()

    await user.click(within(c).getByRole('button', { name: 'Remove SAMPLE' }))
    expect(within(c).queryByText('SAMPLE')).not.toBeInTheDocument()
    await user.type(within(c).getByLabelText('Add name token'), 'TESTER{Enter}')
    expect(within(c).getByText('TESTER')).toBeInTheDocument()
    expect(within(c).getByLabelText('Add name token')).toHaveValue('')
    await user.click(save(c))

    await within(c).findByText('Saved')
    expect(settingsState.configUpdates).toEqual([{ owner_name_tokens: ['ALEX', 'TESTER'] }])
  })

  it('shows a 422 from the server without losing the edit', async () => {
    const user = userEvent.setup()
    renderAt('/settings')
    const c = await card()

    const days = within(c).getByLabelText('First sync history (days)')
    await user.clear(days)
    await user.type(days, '0')
    await user.click(save(c))

    expect(await within(c).findByRole('alert')).toHaveTextContent('body.sync_first_history_days')
    expect(within(c).getByLabelText('First sync history (days)')).toHaveValue(0)
    expect(save(c)).toBeEnabled()
  })

  it('keeps a typed key after a failed save', async () => {
    server.use(
      http.put('/api/settings/config', () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Validation error', status: 422, detail: 'body.anthropic_api_key: Invalid' },
          { status: 422 },
        ),
      ),
    )
    const user = userEvent.setup()
    renderAt('/settings')
    const c = await card()

    await user.type(within(c).getByLabelText('New Anthropic API key'), 'fake-key-456')
    await user.click(save(c))

    expect(await within(c).findByRole('alert')).toHaveTextContent('body.anthropic_api_key: Invalid')
    expect(within(c).getByLabelText('New Anthropic API key')).toHaveValue('fake-key-456')
  })

  it('switches provider, shows the Ollama URL, and refreshes the settings queries', async () => {
    const user = userEvent.setup()
    renderAt('/settings')
    const c = await card()
    expect(await screen.findByText(/Categorization model: claude/)).toBeInTheDocument()

    await user.click(within(c).getByRole('combobox', { name: 'LLM provider' }))
    await user.click(await screen.findByRole('option', { name: 'Ollama' }))
    expect(within(c).queryByLabelText('New Anthropic API key')).not.toBeInTheDocument()
    const url = within(c).getByLabelText('Ollama URL')
    expect(url).toHaveValue('http://localhost:11434')
    await user.clear(url)
    await user.type(url, 'http://127.0.0.1:11434')
    await user.click(save(c))

    await within(c).findByText('Saved')
    expect(settingsState.configUpdates).toEqual([
      { llm_provider: 'ollama', ollama_base_url: 'http://127.0.0.1:11434' },
    ])
    // The LLM status line reads ['settings', 'llm']; the save invalidated it.
    await waitFor(() => expect(screen.getByText(/Categorization model: ollama/)).toBeInTheDocument())
  })
})
