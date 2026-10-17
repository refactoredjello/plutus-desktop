import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'

type Category = Schemas['CategoryRead']

// A slice of the seeded Plaid Personal Finance Categories taxonomy.
const seed: [string, string, string][] = [
  ['INCOME', 'INCOME_SALARY', 'Salary'],
  ['INCOME', 'INCOME_INTEREST_EARNED', 'Interest earned'],
  ['RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT', 'Rent'],
  ['RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY', 'Gas and electricity'],
  ['RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_INTERNET_AND_CABLE', 'Internet and cable'],
  ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE', 'Coffee'],
  ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES', 'Groceries'],
  ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT', 'Restaurant'],
  ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_FAST_FOOD', 'Fast food'],
  ['ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES', 'TV and movies'],
  ['ENTERTAINMENT', 'ENTERTAINMENT_MUSIC_AND_AUDIO', 'Music and audio'],
  ['TRANSPORTATION', 'TRANSPORTATION_GAS', 'Gas'],
  ['TRANSPORTATION', 'TRANSPORTATION_PUBLIC_TRANSIT', 'Public transit'],
  ['GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', 'Online marketplaces'],
  ['MEDICAL', 'MEDICAL_PHARMACIES_AND_SUPPLEMENTS', 'Pharmacies and supplements'],
  ['PERSONAL_CARE', 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS', 'Gyms and fitness centers'],
  ['TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER', 'Account transfer'],
]

const initial = (): Category[] =>
  seed.map(([primary, detailed, label], i) => ({
    id: i + 1,
    primary,
    detailed,
    label,
    description: null,
    is_hidden: false,
    is_custom: false,
  }))

export let categories: Category[] = initial()

export function resetCategories() {
  categories = initial()
}

export const categoryHandlers = [
  http.get('/api/categories', ({ request }) => {
    const includeHidden = new URL(request.url).searchParams.get('include_hidden') === 'true'
    return HttpResponse.json<Category[]>(categories.filter((c) => includeHidden || !c.is_hidden))
  }),
  http.post('/api/categories', async ({ request }) => {
    const body = (await request.json()) as Schemas['CategoryCreate']
    const created: Category = {
      id: Math.max(0, ...categories.map((c) => c.id)) + 1,
      primary: body.primary,
      detailed: `${body.primary}_${body.label.toUpperCase().replace(/\W+/g, '_')}`,
      label: body.label,
      description: body.description ?? null,
      is_hidden: false,
      is_custom: true,
    }
    categories.push(created)
    return HttpResponse.json<Category>(created, { status: 201 })
  }),
  http.patch('/api/categories/:id', async ({ params, request }) => {
    const body = (await request.json()) as Schemas['CategoryUpdate']
    const cat = categories.find((c) => c.id === Number(params.id))
    if (!cat) return HttpResponse.json({ title: 'Not Found', status: 404, detail: 'Category not found' }, { status: 404 })
    if (body.label != null) cat.label = body.label
    if (body.is_hidden != null) cat.is_hidden = body.is_hidden
    return HttpResponse.json<Category>(cat)
  }),
]
