/** Categories and rules. */

import { createRoute } from '@hono/zod-openapi'
import type { App } from '../app.js'
import {
  CategoryCreate,
  CategoryRead,
  CategoryUpdate,
  RuleCreate,
  RulePreview,
  RulePreviewRead,
  RuleRead,
  RuleUpdate,
} from '../schemas/categories.js'
import { params, responseList } from '../schemas/model.js'
import { pathInt, queryBool } from '../schemas/params.js'
import * as service from '../services/categories.js'
import { json, jsonBody, noContent } from './openapi.js'

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

const createRule = createRoute({
  method: 'post',
  path: '/api/rules',
  operationId: 'create_rule',
  summary: 'Create Rule',
  description: 'Upserts by match type and pattern, then applies the rule to existing transactions.',
  tags: ['categories'],
  request: { body: jsonBody(RuleCreate) },
  responses: { 200: json(RuleRead) },
})

const previewRule = createRoute({
  method: 'post',
  path: '/api/rules/preview',
  operationId: 'preview_rule',
  summary: 'Preview Rule',
  description:
    'Counts the non-transfer transactions a rule would match and how many of them were set by hand, ' +
    'which a rule leaves as they are. Saves nothing.',
  tags: ['categories'],
  request: { body: jsonBody(RulePreview) },
  responses: { 200: json(RulePreviewRead) },
})

const updateRule = createRoute({
  method: 'patch',
  path: '/api/rules/{rule_id}',
  operationId: 'update_rule',
  summary: 'Update Rule',
  description:
    'Changes a rule, then re-applies it to existing transactions. Transactions the old rule matched ' +
    'and the new one does not keep their category.',
  tags: ['categories'],
  request: { params: params({ rule_id: pathInt() }), body: jsonBody(RuleUpdate) },
  responses: { 200: json(RuleRead) },
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
  app.openapi(listCategories, (c) => c.json(service.listCategories(c.var.db, c.req.valid('query').include_hidden), 200))
  app.openapi(createCategory, (c) => c.json(service.createCategory(c.var.db, c.req.valid('json')), 201))
  app.openapi(updateCategory, (c) =>
    c.json(service.updateCategory(c.var.db, c.req.valid('param').category_id, c.req.valid('json')), 200),
  )
  app.openapi(listRules, (c) => c.json(service.listRules(c.var.db), 200))
  app.openapi(createRule, (c) => c.json(service.createRule(c.var.db, c.req.valid('json')), 200))
  app.openapi(previewRule, (c) => c.json(service.previewRule(c.var.db, c.req.valid('json')), 200))
  app.openapi(updateRule, (c) =>
    c.json(service.updateRule(c.var.db, c.req.valid('param').rule_id, c.req.valid('json')), 200),
  )
  app.openapi(deleteRule, (c) => {
    service.deleteRule(c.var.db, c.req.valid('param').rule_id)
    return c.body(null, 204)
  })
}
