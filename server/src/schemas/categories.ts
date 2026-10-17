/** Ports app/schemas/categories.py. */

import { z } from '@hono/zod-openapi'
import { DateTime } from './common.js'
import { Essentiality, RuleMatchType } from './enums.js'
import { model, orNull, requestModel } from './model.js'

export const CategoryRead = model('CategoryRead', {
  id: z.int(),
  primary: z.string(),
  detailed: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  is_hidden: z.boolean(),
  is_custom: z.boolean(),
})
export type CategoryRead = z.infer<typeof CategoryRead>

export const CategoryCreate = requestModel('CategoryCreate', {
  primary: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
  description: z.string().nullable().optional(),
})
export type CategoryCreate = z.infer<typeof CategoryCreate>

export const CategoryUpdate = requestModel('CategoryUpdate', {
  label: z.string().min(1).max(100).nullable().optional(),
  is_hidden: z.boolean().nullable().optional(),
})
export type CategoryUpdate = z.infer<typeof CategoryUpdate>

export const RuleRead = model('RuleRead', {
  id: z.int(),
  match_type: RuleMatchType,
  pattern: z.string(),
  category_id: z.int(),
  essentiality: orNull(Essentiality),
  created_at: DateTime,
})
export type RuleRead = z.infer<typeof RuleRead>
