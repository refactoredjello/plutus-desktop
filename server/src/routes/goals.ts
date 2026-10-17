/** Goals and savings suggestions (R8). Ports app/routers/goals.py (stub). */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { GoalCreate, GoalRead, GoalUpdate, SuggestionRead, SuggestionUpdate } from '../schemas/goals.js'
import { params, responseList } from '../schemas/model.js'
import { pathInt } from '../schemas/params.js'
import { json, jsonBody, notImplemented } from './openapi.js'

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
  app.openapi(listGoals, notImplemented)
  app.openapi(createGoal, notImplemented)
  app.openapi(getGoal, notImplemented)
  app.openapi(updateGoal, notImplemented)
  app.openapi(listSuggestions, notImplemented)
  app.openapi(generateSuggestions, notImplemented)
  app.openapi(updateSuggestion, notImplemented)
}
