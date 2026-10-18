/**
 * Category and rule management (R3.1, R2.3).
 *
 * Rows are returned as stored; their columns are exactly CategoryRead's and RuleRead's.
 * ORDER BY on text uses SQLite's default BINARY (bytewise) collation.
 */

import { asc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { categories, rules } from '../db/schema.js'
import { ConflictError, DomainError, NotFoundError } from '../lib/errors.js'
import type { CategoryCreate, CategoryUpdate } from '../schemas/categories.js'

export type Category = typeof categories.$inferSelect
export type Rule = typeof rules.$inferSelect

/** detailed is at most 100 characters and carries a "CUSTOM_" prefix. */
const MAX_SLUG = 90

/** Whitespace for stripping: ASCII whitespace, \x1c-\x1f, and the Unicode spaces (not trim()'s set). */
const UNICODE_SPACE = String.raw`[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]`
const UNICODE_STRIP = new RegExp(`^${UNICODE_SPACE}+|${UNICODE_SPACE}+$`, 'gu')

/** Strip UNICODE_SPACE from both ends. */
export function pyStrip(text: string): string {
  return text.replace(UNICODE_STRIP, '')
}

/** Strip leading and trailing underscores. */
const stripUnderscores = (text: string): string => text.replace(/^_+|_+$/g, '')

/** Upper case, runs of anything but A-Z and 0-9 to "_", trimmed of "_", cut to MAX_SLUG, trimmed again. */
function slug(text: string): string {
  // After the substitution the text is ASCII, so slicing UTF-16 units slices characters.
  return stripUnderscores(stripUnderscores(text.toUpperCase().replace(/[^A-Z0-9]+/g, '_')).slice(0, MAX_SLUG))
}

export function listCategories(db: Db, includeHidden: boolean): Category[] {
  const query = db.select().from(categories)
  return (includeHidden ? query : query.where(eq(categories.is_hidden, false)))
    .orderBy(asc(categories.primary), asc(categories.detailed))
    .all()
}

export function createCategory(db: Db, body: CategoryCreate): Category {
  const primary = slug(body.primary)
  const label = pyStrip(body.label)
  const labelSlug = slug(label)
  if (!primary || !labelSlug) throw new DomainError('Primary and label must contain letters or digits')
  const detailed = `CUSTOM_${labelSlug}`
  if (db.select({ id: categories.id }).from(categories).where(eq(categories.detailed, detailed)).get() !== undefined) {
    throw new ConflictError(`Category ${detailed} already exists`)
  }
  return db
    .insert(categories)
    .values({ primary, detailed, label, description: body.description ?? null, is_custom: true })
    .returning()
    .get()
}

export function updateCategory(db: Db, categoryId: number, body: CategoryUpdate): Category {
  const category = db.select().from(categories).where(eq(categories.id, categoryId)).get()
  if (category === undefined) throw new NotFoundError(`Category ${categoryId} not found`)
  const changes: Partial<Pick<Category, 'label' | 'is_hidden'>> = {}
  if (body.label != null) changes.label = pyStrip(body.label)
  if (body.is_hidden != null) changes.is_hidden = body.is_hidden
  if (Object.keys(changes).length === 0) return category
  return db.update(categories).set(changes).where(eq(categories.id, categoryId)).returning().get()
}

export function listRules(db: Db): Rule[] {
  return db.select().from(rules).orderBy(asc(rules.id)).all()
}

export function deleteRule(db: Db, ruleId: number): void {
  const rule = db.select({ id: rules.id }).from(rules).where(eq(rules.id, ruleId)).get()
  if (rule === undefined) throw new NotFoundError(`Rule ${ruleId} not found`)
  db.delete(rules).where(eq(rules.id, ruleId)).run()
}
