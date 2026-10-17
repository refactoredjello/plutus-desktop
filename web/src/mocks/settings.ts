import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'

const disconnected = (): Schemas['SimpleFINStatus'] => ({ connected: false, connected_at: null })

export const settingsState = { simplefin: disconnected() }

export function resetSettings() {
  settingsState.simplefin = disconnected()
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
  http.get('/api/settings/llm', () =>
    HttpResponse.json<Schemas['LLMStatus']>({ provider: 'anthropic', model: 'claude-haiku-4-5', configured: true }),
  ),
]
