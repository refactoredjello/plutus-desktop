import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'

type Rule = Schemas['RuleRead']

const initial = (): Rule[] => [
  { id: 1, match_type: 'exact', pattern: 'NETFLIX.COM CA', category_id: 10, essentiality: 'discretionary', created_at: '2026-09-20T10:00:00Z' },
  { id: 2, match_type: 'prefix', pattern: 'SHELL OIL', category_id: 12, essentiality: null, created_at: '2026-09-21T10:00:00Z' },
  { id: 3, match_type: 'contains', pattern: 'PAYPAL INST XFER JANEDOE', category_id: 11, essentiality: null, created_at: '2026-09-22T10:00:00Z' },
]

export let rules: Rule[] = initial()

export function resetRules() {
  rules = initial()
}

export const ruleHandlers = [
  http.get('/api/rules', () => HttpResponse.json<Rule[]>(rules)),
  http.delete('/api/rules/:id', ({ params }) => {
    rules = rules.filter((r) => r.id !== Number(params.id))
    return new HttpResponse(null, { status: 204 })
  }),
]
