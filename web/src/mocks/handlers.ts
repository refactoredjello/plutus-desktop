/**
 * MSW handlers for developing pages before their backend exists.
 * One file per domain; keep response bodies typed with Schemas.
 * Handlers are stateful in memory; call resetMockState() between tests.
 */
import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'
import { accountHandlers } from './accounts'
import { categoryHandlers, resetCategories } from './categories'
import { changesHandlers, resetChanges } from './changes'
import { goalHandlers, resetGoals } from './goals'
import { monthHandlers } from './month'
import { plannedHandlers, resetPlanned } from './planned'
import { recurringHandlers, resetRecurring } from './recurring'
import { resetRules, ruleHandlers } from './rules'
import { projectionHandlers } from './projection'
import { reportHandlers } from './reports'
import { resetSettings, settingsHandlers } from './settings'
import { resetSync, syncHandlers } from './sync'
import { resetTransactions, transactionHandlers } from './transactions'

export const handlers = [
  http.get('/api/health', () =>
    HttpResponse.json<Schemas['HealthRead']>({ status: 'ok', database: 'ok', version: 'mock' }),
  ),
  ...accountHandlers,
  ...categoryHandlers,
  ...projectionHandlers,
  ...reportHandlers,
  ...monthHandlers,
  ...settingsHandlers,
  ...syncHandlers,
  ...transactionHandlers,
  ...recurringHandlers,
  ...plannedHandlers,
  ...goalHandlers,
  ...ruleHandlers,
  ...changesHandlers,
]

export function resetMockState() {
  resetCategories()
  resetSettings()
  resetSync()
  resetTransactions()
  resetRecurring()
  resetPlanned()
  resetGoals()
  resetRules()
  resetChanges()
}
