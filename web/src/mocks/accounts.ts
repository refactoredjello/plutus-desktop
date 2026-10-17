import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'

export const accounts: Schemas['AccountRead'][] = [
  { id: 1, name: 'Everyday Checking', type: 'checking', institution_name: 'First Example Bank', currency: 'USD', is_active: true, balance: '4821.17', available: '4721.17', balance_as_of: '2026-10-02T06:00:00Z' },
  { id: 2, name: 'High-Yield Savings', type: 'savings', institution_name: 'First Example Bank', currency: 'USD', is_active: true, balance: '18250.00', available: '18250.00', balance_as_of: '2026-10-02T06:00:00Z' },
  { id: 3, name: 'Rewards Visa', type: 'credit', institution_name: 'Sample Card Co.', currency: 'USD', is_active: true, balance: '-1243.88', available: '8756.12', balance_as_of: '2026-10-02T06:00:00Z' },
]

export const accountHandlers = [
  http.get('/api/accounts', () => HttpResponse.json<Schemas['AccountRead'][]>(accounts)),
]
