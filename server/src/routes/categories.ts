/** Categories and rules. Ports app/routers/categories.py (stub). */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import { CategoryCreate, CategoryRead, CategoryUpdate, RuleRead } from '../schemas/categories.js'
import { params, responseList } from '../schemas/model.js'
import { pathInt, queryBool } from '../schemas/params.js'
import { json, jsonBody, noContent, notImplemented } from './openapi.js'

const listCategories = createRoute({
  method: 'get',
  path: '/api/categories',
  operationId: 'list_categories',
  summary: 'List Categories',
  tags: ['categories'],
  request: { query: params({ include_hidden: queryBool(false) }) },
  responses: { 200: json(responseList(CategoryRead, 'list_categories')) },
})

const createCategory = createRoute({
  method: 'post',
  path: '/api/categories',
  operationId: 'create_category',
  summary: 'Create Category',
  tags: ['categories'],
  request: { body: jsonBody(CategoryCreate) },
  responses: { 201: json(CategoryRead) },
})

const updateCategory = createRoute({
  method: 'patch',
  path: '/api/categories/{category_id}',
  operationId: 'update_category',
  summary: 'Update Category',
  tags: ['categories'],
  request: { params: params({ category_id: pathInt() }), body: jsonBody(CategoryUpdate) },
  responses: { 200: json(CategoryRead) },
})

const listRules = createRoute({
  method: 'get',
  path: '/api/rules',
  operationId: 'list_rules',
  summary: 'List Rules',
  tags: ['categories'],
  responses: { 200: json(responseList(RuleRead, 'list_rules')) },
})

const deleteRule = createRoute({
  method: 'delete',
  path: '/api/rules/{rule_id}',
  operationId: 'delete_rule',
  summary: 'Delete Rule',
  tags: ['categories'],
  request: { params: params({ rule_id: pathInt() }) },
  responses: { 204: noContent },
})

export function registerCategories(app: App): void {
  app.openapi(listCategories, notImplemented)
  app.openapi(createCategory, notImplemented)
  app.openapi(updateCategory, notImplemented)
  app.openapi(listRules, notImplemented)
  app.openapi(deleteRule, notImplemented)
}
