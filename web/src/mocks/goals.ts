import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'

type Goal = Schemas['GoalRead']
type Suggestion = Schemas['SuggestionRead']

const progress = (target: number, saved: number, monthsLeft: number, actual: number): Schemas['GoalProgress'] => {
  const remaining = Math.max(0, target - saved)
  const required = monthsLeft > 0 ? remaining / monthsLeft : remaining
  return {
    saved_so_far: saved.toFixed(2),
    remaining: remaining.toFixed(2),
    months_left: monthsLeft,
    required_monthly: required.toFixed(2),
    actual_monthly_average: actual.toFixed(2),
    on_track: actual >= required,
  }
}

const initial = (): Goal[] => [
  { id: 1, name: 'Vacation fund', target_amount: '9000.00', target_date: '2027-10-01', starting_amount: '0.00', is_active: true, progress: progress(9000, 3000, 8, 650) },
  { id: 2, name: 'Emergency fund', target_amount: '5000.00', target_date: '2027-04-01', starting_amount: '0.00', is_active: true, progress: progress(5000, 4000, 6, 400) },
]

export let goals: Goal[] = initial()
export let suggestions: Suggestion[] = []
/** Set to a problem detail to make the next suggestion request fail with a 502. */
export const mockFlags: { suggestFailure: string | null } = { suggestFailure: null }

export function resetGoals() {
  goals = initial()
  suggestions = []
  mockFlags.suggestFailure = null
}

const problem = (status: number, title: string, detail: string) =>
  HttpResponse.json({ title, status, detail }, { status })

export const goalHandlers = [
  http.get('/api/goals', () => HttpResponse.json<Goal[]>(goals)),
  http.post('/api/goals', async ({ request }) => {
    const body = (await request.json()) as Schemas['GoalCreate']
    const target = Number(body.target_amount)
    const created: Goal = {
      id: Math.max(0, ...goals.map((g) => g.id)) + 1,
      name: body.name,
      target_amount: target.toFixed(2),
      target_date: body.target_date,
      starting_amount: '0.00',
      is_active: true,
      progress: progress(target, 0, 12, 0),
    }
    goals.push(created)
    return HttpResponse.json<Goal>(created, { status: 201 })
  }),
  http.patch('/api/goals/:id', async ({ params, request }) => {
    const body = (await request.json()) as Schemas['GoalUpdate']
    const goal = goals.find((g) => g.id === Number(params.id))
    if (!goal) return problem(404, 'Not Found', 'Goal not found')
    if (body.name != null) goal.name = body.name
    if (body.target_amount != null) goal.target_amount = Number(body.target_amount).toFixed(2)
    if (body.target_date != null) goal.target_date = body.target_date
    if (body.is_active != null) goal.is_active = body.is_active
    return HttpResponse.json<Goal>(goal)
  }),
  http.get('/api/goals/:id/suggestions', ({ params }) =>
    HttpResponse.json<Suggestion[]>(
      suggestions.filter((s) => s.goal_id === Number(params.id)).sort((a, b) => b.id - a.id),
    ),
  ),
  http.post('/api/goals/:id/suggestions', async ({ params }) => {
    await new Promise((r) => setTimeout(r, 50))
    if (mockFlags.suggestFailure) return problem(502, 'Bad Gateway', mockFlags.suggestFailure)
    const base = Math.max(0, ...suggestions.map((s) => s.id))
    const created: Suggestion[] = [
      { id: base + 1, goal_id: Number(params.id), text: 'Cancel unused subscriptions', category_id: null, estimated_monthly_saving: '45.00', status: 'open', created_at: '2026-10-03T10:00:00Z' },
      { id: base + 2, goal_id: Number(params.id), text: 'Cook at home twice more a week', category_id: null, estimated_monthly_saving: '120.00', status: 'open', created_at: '2026-10-03T10:00:00Z' },
    ]
    suggestions.push(...created)
    return HttpResponse.json<Suggestion[]>(created, { status: 201 })
  }),
  http.patch('/api/suggestions/:id', async ({ params, request }) => {
    const body = (await request.json()) as Schemas['SuggestionUpdate']
    const s = suggestions.find((x) => x.id === Number(params.id))
    if (!s) return problem(404, 'Not Found', 'Suggestion not found')
    s.status = body.status
    return HttpResponse.json<Suggestion>(s)
  }),
]
