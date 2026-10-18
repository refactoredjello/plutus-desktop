/** Request and response schemas for categories and rules. */

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

export const RuleCreate = requestModel(
  'RuleCreate',
  {
    match_type: RuleMatchType,
    pattern: z.string().min(1).max(200), // exact and prefix are upper-cased to match merchant keys
    category_id: z.int(),
    essentiality: orNull(Essentiality).optional(),
  },
  'A rule, upserted by match type and pattern and applied to existing transactions.',
)
export type RuleCreate = z.infer<typeof RuleCreate>

export const RuleUpdate = requestModel(
  'RuleUpdate',
  {
    match_type: RuleMatchType.optional(),
    pattern: z.string().min(1).max(200).optional(), // normalized as on create
    category_id: z.int().optional(),
    essentiality: orNull(Essentiality).optional(), // null clears it; left out keeps it
  },
  'Changes to a rule; fields left out keep their value. The rule is re-applied to existing transactions.',
)
export type RuleUpdate = z.infer<typeof RuleUpdate>
