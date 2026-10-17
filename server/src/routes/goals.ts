/** Goals and savings suggestions (R8). Ports app/routers/goals.py. */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { formatMoney } from '../lib/money.js'
import { GoalCreate, GoalRead, GoalUpdate, SuggestionRead, SuggestionUpdate } from '../schemas/goals.js'
import { params, responseList } from '../schemas/model.js'
import { pathInt } from '../schemas/params.js'
import * as goalsService from '../services/goals.js'
import { json, jsonBody, notImplemented } from './openapi.js'

function readGoal(goal: goalsService.GoalView): GoalRead {
  const p = goal.progress
  return {
    id: goal.id,
    name: goal.name,
    target_amount: formatMoney(goal.target_amount),
    target_date: goal.target_date,
    starting_amount: formatMoney(goal.starting_amount),
    is_active: goal.is_active,
    progress: {
      saved_so_far: formatMoney(p.saved_so_far),
      remaining: formatMoney(p.remaining),
      months_left: p.months_left,
      required_monthly: formatMoney(p.required_monthly),
      actual_monthly_average: formatMoney(p.actual_monthly_average),
      on_track: p.on_track,
    },
  }
}

const listGoals = createRoute({
  method: 'get',
  path: '/api/goals',
  operationId: 'list_goals',
  summary: 'List Goals',
  tags: ['goals'],
  responses: { 200: json(responseList(GoalRead, 'list_goals')) },
})

const createGoal = createRoute({
  method: 'post',
  path: '/api/goals',
  operationId: 'create_goal',
  summary: 'Create Goal',
  tags: ['goals'],
  request: { body: jsonBody(GoalCreate) },
  responses: { 201: json(GoalRead) },
})

const getGoal = createRoute({
  method: 'get',
  path: '/api/goals/{goal_id}',
  operationId: 'get_goal',
  summary: 'Get Goal',
  tags: ['goals'],
  request: { params: params({ goal_id: pathInt() }) },
  responses: { 200: json(GoalRead) },
})

const updateGoal = createRoute({
  method: 'patch',
  path: '/api/goals/{goal_id}',
  operationId: 'update_goal',
  summary: 'Update Goal',
  tags: ['goals'],
  request: { params: params({ goal_id: pathInt() }), body: jsonBody(GoalUpdate) },
  responses: { 200: json(GoalRead) },
})

const listSuggestions = createRoute({
  method: 'get',
  path: '/api/goals/{goal_id}/suggestions',
  operationId: 'list_suggestions',
  summary: 'List Suggestions',
  tags: ['goals'],
  request: { params: params({ goal_id: pathInt() }) },
  responses: { 200: json(responseList(SuggestionRead, 'list_suggestions')) },
})

const generateSuggestions = createRoute({
  method: 'post',
  path: '/api/goals/{goal_id}/suggestions',
  operationId: 'generate_suggestions',
  summary: 'Generate Suggestions',
  description: 'Ask the LLM for new savings suggestions from aggregates only.',
  tags: ['goals'],
  request: { params: params({ goal_id: pathInt() }) },
  responses: { 201: json(responseList(SuggestionRead, 'generate_suggestions')) },
})

const updateSuggestion = createRoute({
  method: 'patch',
  path: '/api/suggestions/{suggestion_id}',
  operationId: 'update_suggestion',
  summary: 'Update Suggestion',
  tags: ['goals'],
  request: { params: params({ suggestion_id: pathInt() }), body: jsonBody(SuggestionUpdate) },
  responses: { 200: json(SuggestionRead) },
})

export function registerGoals(app: App): void {
  app.openapi(listGoals, (c) => {
    const db = c.var.db
    return c.json(
      goalsService.listGoals(db).map((g) => readGoal(goalsService.toRead(db, g))),
      200,
    )
  })
  app.openapi(createGoal, (c) => {
    const db = c.var.db
    return c.json(readGoal(goalsService.toRead(db, goalsService.createGoal(db, c.req.valid('json')))), 201)
  })
  app.openapi(getGoal, (c) => {
    const db = c.var.db
    const { goal_id } = c.req.valid('param')
    return c.json(readGoal(goalsService.toRead(db, goalsService.getGoal(db, goal_id))), 200)
  })
  app.openapi(updateGoal, (c) => {
    const db = c.var.db
    const { goal_id } = c.req.valid('param')
    return c.json(readGoal(goalsService.toRead(db, goalsService.updateGoal(db, goal_id, c.req.valid('json')))), 200)
  })
  app.openapi(listSuggestions, notImplemented)
  app.openapi(generateSuggestions, notImplemented)
  app.openapi(updateSuggestion, notImplemented)
}
