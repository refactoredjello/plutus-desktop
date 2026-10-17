import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'

const disconnected = (): Schemas['SimpleFINStatus'] => ({ connected: false, connected_at: null })

const defaultConfig = (): Schemas['ConfigRead'] => ({
  llm_provider: 'claude',
  llm_model: 'claude-haiku-4-5',
  anthropic_api_key_set: true,
  ollama_base_url: 'http://localhost:11434',
  owner_name_tokens: ['ALEX', 'SAMPLE'],
  sync_interval_hours: 6,
  sync_first_history_days: 180,
  scheduler_enabled: true,
})

export const settingsState = {
  simplefin: disconnected(),
  config: defaultConfig(),
  /** Bodies of every PUT /api/settings/config, so tests can assert exactly what was sent. */
  configUpdates: [] as Schemas['ConfigUpdate'][],
}

export function resetSettings() {
  settingsState.simplefin = disconnected()
  settingsState.config = defaultConfig()
  settingsState.configUpdates = []
}

/** Mirrors the server's ConfigUpdate checks, answering 422 problem+json like it does. */
function configIssues(body: Schemas['ConfigUpdate']): string[] {
  const issues: string[] = []
  if (body.llm_model !== undefined && body.llm_model.length < 1) {
    issues.push('body.llm_model: Too small: expected string to have >=1 characters')
  }
  for (const key of ['sync_interval_hours', 'sync_first_history_days'] as const) {
    const value = body[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1)) {
      issues.push(`body.${key}: Too small: expected number to be >=1`)
    }
  }
  return issues
}

export const settingsHandlers = [
  http.get('/api/settings/simplefin', () => HttpResponse.json<Schemas['SimpleFINStatus']>(settingsState.simplefin)),
  http.post('/api/settings/simplefin', async ({ request }) => {
    const body = (await request.json()) as Schemas['SimpleFINConnect']
    if (!body.setup_token.trim()) {
      return HttpResponse.json({ title: 'Bad Request', status: 400, detail: 'Setup token is empty' }, { status: 400 })
    }
    settingsState.simplefin = { connected: true, connected_at: new Date().toISOString() }
    return HttpResponse.json<Schemas['SimpleFINStatus']>(settingsState.simplefin)
  }),
  http.delete('/api/settings/simplefin', () => {
    settingsState.simplefin = disconnected()
    return new HttpResponse(null, { status: 204 })
  }),
  http.get('/api/settings/llm', () => {
    const c = settingsState.config
    return HttpResponse.json<Schemas['LLMStatus']>({
      provider: c.llm_provider,
      model: c.llm_model,
      configured: c.llm_provider !== 'claude' || c.anthropic_api_key_set,
    })
  }),
  http.get('/api/settings/config', () => HttpResponse.json<Schemas['ConfigRead']>(settingsState.config)),
  http.put('/api/settings/config', async ({ request }) => {
    const body = (await request.json()) as Schemas['ConfigUpdate']
    settingsState.configUpdates.push(body)
    const issues = configIssues(body)
    if (issues.length) {
      return HttpResponse.json(
        { type: 'about:blank', title: 'Validation error', status: 422, detail: issues.join('; ') },
        { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
      )
    }
    const { anthropic_api_key, ...rest } = body
    const next = { ...settingsState.config, ...rest }
    if (anthropic_api_key !== undefined) next.anthropic_api_key_set = !!anthropic_api_key?.trim()
    settingsState.config = next
    return HttpResponse.json<Schemas['ConfigRead']>(settingsState.config)
  }),
]
