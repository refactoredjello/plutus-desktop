import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'

type Entry = Schemas['ManualEntryRead']

const initial = (): Entry[] => [
  { id: 1, amount: '-1200.00', description: 'Car insurance', category_id: null, due_date: '2026-11-15', recurrence: 'yearly', end_date: null, fulfilled_transaction_id: null },
  { id: 2, amount: '500.00', description: 'Freelance invoice', category_id: 1, due_date: '2026-10-20', recurrence: 'none', end_date: null, fulfilled_transaction_id: null },
  { id: 3, amount: '-60.00', description: 'Dentist', category_id: null, due_date: '2026-09-10', recurrence: 'none', end_date: null, fulfilled_transaction_id: 900 },
]

export let plannedEntries: Entry[] = initial()

export function resetPlanned() {
  plannedEntries = initial()
}

const problem = (status: number, detail: string) =>
  HttpResponse.json({ title: status === 404 ? 'Not Found' : 'Bad Request', status, detail }, { status })

function validate(recurrence: string, due: string, end: string | null | undefined) {
  if (end && recurrence === 'none') return 'end_date is only allowed for recurring entries'
  if (end && end < due) return 'end_date must be on or after due_date'
  return null
}

export const plannedHandlers = [
  http.get('/api/manual-entries', () => HttpResponse.json<Entry[]>(plannedEntries)),
  http.post('/api/manual-entries', async ({ request }) => {
    const body = (await request.json()) as Schemas['ManualEntryCreate']
    const recurrence = body.recurrence ?? 'none'
    const error = validate(recurrence, body.due_date, body.end_date)
    if (error) return problem(400, error)
    const created: Entry = {
      id: Math.max(0, ...plannedEntries.map((e) => e.id)) + 1,
      amount: Number(body.amount).toFixed(2),
      description: body.description,
      category_id: body.category_id ?? null,
      due_date: body.due_date,
      recurrence,
      end_date: body.end_date ?? null,
      fulfilled_transaction_id: null,
    }
    plannedEntries.push(created)
    return HttpResponse.json<Entry>(created, { status: 201 })
  }),
  http.patch('/api/manual-entries/:id', async ({ params, request }) => {
    const body = (await request.json()) as Schemas['ManualEntryUpdate']
    const entry = plannedEntries.find((e) => e.id === Number(params.id))
    if (!entry) return problem(404, 'Manual entry not found')
    const next = {
      recurrence: body.recurrence ?? entry.recurrence,
      due_date: body.due_date ?? entry.due_date,
      end_date: body.end_date !== undefined ? body.end_date : entry.end_date,
    }
    const error = validate(next.recurrence, next.due_date, next.end_date)
    if (error) return problem(400, error)
    if (body.amount != null) entry.amount = Number(body.amount).toFixed(2)
    if (body.description != null) entry.description = body.description
    if (body.category_id !== undefined) entry.category_id = body.category_id
    Object.assign(entry, next)
    return HttpResponse.json<Entry>(entry)
  }),
  http.delete('/api/manual-entries/:id', ({ params }) => {
    plannedEntries = plannedEntries.filter((e) => e.id !== Number(params.id))
    return new HttpResponse(null, { status: 204 })
  }),
]
