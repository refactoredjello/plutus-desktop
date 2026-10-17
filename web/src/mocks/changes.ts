import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'

type Item = Schemas['ChangeItem']

const initial = (): Item[] => [
  { signal: 'S1', key: 'S1:recurrence:1:2299', text: 'Netflix went from $15.49 to $22.99.', amount: '22.99', href: '/recurring' },
  { signal: 'S2', key: 'S2:recurrence:3:2026-09-28', text: 'Gym membership hasn’t posted; expected Sep 28.', amount: null, href: '/recurring' },
  { signal: 'S3', key: 'S3:planned:7', text: 'Car insurance ($412) was due Oct 1 and hasn’t matched a transaction.', amount: '412.00', href: '/planned' },
  { signal: 'S4', key: 'S4:category:17:2026-10', text: 'Restaurants is $340 so far, 48% above your usual pace.', amount: '340.00', href: '/transactions?category=17&start=2026-10-01&end=2026-10-31' },
  { signal: 'S5', key: 'S5:merchant:HOME DEPOT:2026-10', text: 'First purchase at Home Depot: $486.', amount: '486.00', href: '/transactions?q=Home%20Depot&start=2026-10-01&end=2026-10-31' },
  { signal: 'S6', key: 'S6:txn:991', text: '$1,200 to Delta Air Lines on Oct 2.', amount: '1200.00', href: '/transactions?q=DELTA%20AIR%20LINES&start=2026-10-01&end=2026-10-31' },
  { signal: 'S7', key: 'S7:review:2026-10', text: '14 transactions need a category, including one for $340.', amount: null, href: '/review' },
  { signal: 'S8', key: 'S8:discretionary:2026-10', text: 'Discretionary spending is running 31% above usual.', amount: null, href: '/spending?essentiality=discretionary&month=2026-10' },
  { signal: 'S9', key: 'S9:projection:2026-10', text: 'Projected month-end balance is −$410.', amount: '-410.00', href: '/#balance' },
]

const CAP = 7
let all: Item[] = initial()
let averageMonths = 3

export function resetChanges() {
  all = initial()
  averageMonths = 3
}

export const setAverageMonths = (n: number) => {
  averageMonths = n
}

export const changesHandlers = [
  http.get('/api/reports/changes', ({ request }) => {
    const showAll = new URL(request.url).searchParams.get('all') === 'true'
    const items = showAll ? all : all.slice(0, CAP)
    return HttpResponse.json<Schemas['ChangesRead']>({
      as_of: '2026-10-04',
      average_months: averageMonths,
      items,
      hidden: showAll ? 0 : all.length - items.length,
    })
  }),
  http.post('/api/reports/changes/dismiss', async ({ request }) => {
    const { key } = (await request.json()) as Schemas['DismissChange']
    all = all.filter((i) => i.key !== key)
    return new HttpResponse(null, { status: 204 })
  }),
  http.delete('/api/reports/changes/dismissals', () => {
    all = initial()
    return new HttpResponse(null, { status: 204 })
  }),
]
