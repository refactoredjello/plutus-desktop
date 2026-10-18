/**
 * Category and rule management (R3.1, R2.3).
 *
 * Rows are returned as stored; their columns are exactly CategoryRead's and RuleRead's.
 * ORDER BY on text uses SQLite's default BINARY (bytewise) collation.
 *
 * Rules and the merchant cache: saving an exact rule writes a manual cache entry for its key;
 * prefix and contains rules write none. Deleting a rule removes the manual cache rows it may
 * have created, including those written for prefix and contains rules before that changed.
 * Editing a rule removes the old version's rows the same way, then saves the new version as
 * creating it would.
 */

import { and, asc, eq, isNotNull, ne } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import {
  type Essentiality,
  type RuleMatchType,
  categories,
  merchantClassifications,
  rules,
  transactions,
} from '../db/schema.js'
import { ConflictError, DomainError, NotFoundError } from '../lib/errors.js'
import type { CategoryCreate, CategoryUpdate, RuleCreate, RuleUpdate } from '../schemas/categories.js'
import { applyRule, containsPattern } from './categorize.js'

export type Category = typeof categories.$inferSelect
export type Rule = typeof rules.$inferSelect

/** detailed is at most 100 characters and carries a "CUSTOM_" prefix. */
const MAX_SLUG = 90

/** Whitespace for stripping: ASCII whitespace, \x1c-\x1f, and the Unicode spaces (not trim()'s set). */
const UNICODE_SPACE = String.raw`[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]`
const UNICODE_STRIP = new RegExp(`^${UNICODE_SPACE}+|${UNICODE_SPACE}+$`, 'gu')
const UNICODE_SPACES = new RegExp(`${UNICODE_SPACE}+`, 'gu')

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

/**
 * A rule's pattern as stored: stripped; exact and prefix patterns also have inner whitespace
 * collapsed and are upper-cased, as merchant keys are. An empty pattern is an error.
 */
export function normalizePattern(matchType: RuleMatchType, text: string): string {
  const stripped = pyStrip(text)
  const pattern = matchType === 'contains' ? stripped : stripped.replace(UNICODE_SPACES, ' ').toUpperCase()
  if (!pattern) throw new DomainError('Rule pattern must not be empty')
  return pattern
}

/** The fields that define a rule; the pattern is normalized here. */
export interface RuleFields {
  match_type: RuleMatchType
  pattern: string
  category_id: number
  essentiality: Essentiality | null
}

/**
 * Upsert a rule by match type and pattern, write the cache entry for an exact rule, and apply
 * the rule to existing transactions. The category must exist.
 */
export function saveRule(db: Db, fields: RuleFields): Rule {
  const pattern = normalizePattern(fields.match_type, fields.pattern)
  const { match_type, category_id, essentiality } = fields
  return db.transaction(() => {
    const existing = db
      .select()
      .from(rules)
      .where(and(eq(rules.match_type, match_type), eq(rules.pattern, pattern)))
      .get()
    let rule: Rule
    if (existing === undefined) {
      rule = db.insert(rules).values({ match_type, pattern, category_id, essentiality }).returning().get()
    } else if (existing.category_id !== category_id || existing.essentiality !== essentiality) {
      rule = db.update(rules).set({ category_id, essentiality }).where(eq(rules.id, existing.id)).returning().get()
    } else {
      rule = existing
    }

    if (match_type === 'exact') writeCacheEntry(db, pattern, category_id, essentiality)
    applyRule(db, rule)
    return rule
  })
}

/** Upsert the manual cache entry for an exact rule's key; unchanged rows keep updated_at. */
function writeCacheEntry(db: Db, key: string, categoryId: number, essentiality: Essentiality | null): void {
  const values = { category_id: categoryId, essentiality, confidence: 'very_high' as const, source: 'manual' as const }
  const entry = db.select().from(merchantClassifications).where(eq(merchantClassifications.merchant_key, key)).get()
  if (entry === undefined) {
    db.insert(merchantClassifications).values({ merchant_key: key, ...values }).run()
    return
  }
  const changed = (Object.keys(values) as (keyof typeof values)[]).some((k) => entry[k] !== values[k])
  if (changed) db.update(merchantClassifications).set(values).where(eq(merchantClassifications.merchant_key, key)).run()
}

function requireCategory(db: Db, categoryId: number): void {
  if (db.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId)).get() === undefined) {
    throw new DomainError(`Unknown category ${categoryId}`)
  }
}

/** POST /api/rules: a rule from the rule builder. */
export function createRule(db: Db, body: RuleCreate): Rule {
  requireCategory(db, body.category_id)
  return saveRule(db, {
    match_type: body.match_type,
    pattern: body.pattern,
    category_id: body.category_id,
    essentiality: body.essentiality ?? null,
  })
}

/**
 * PATCH /api/rules/{id}: change any of match type, pattern, category, and essentiality (null
 * clears it). The pattern, given or kept, is normalized for the resulting match type. An edit
 * that changes something undoes the old version's cache rows as deleting it would, then writes
 * the new version's cache entry (exact rules only) and applies it to existing transactions,
 * skipping manual categorizations, as creating it would.
 *
 * Transactions the old version categorized that the new one no longer matches keep their
 * category and source: an edit never uncategorizes anything.
 */
export function updateRule(db: Db, ruleId: number, body: RuleUpdate): Rule {
  const old = db.select().from(rules).where(eq(rules.id, ruleId)).get()
  if (old === undefined) throw new NotFoundError(`Rule ${ruleId} not found`)
  if (body.category_id !== undefined) requireCategory(db, body.category_id)
  const match_type = body.match_type ?? old.match_type
  const pattern = normalizePattern(match_type, body.pattern ?? old.pattern)
  const category_id = body.category_id ?? old.category_id
  const essentiality = body.essentiality === undefined ? old.essentiality : body.essentiality
  if (
    match_type === old.match_type &&
    pattern === old.pattern &&
    category_id === old.category_id &&
    essentiality === old.essentiality
  ) {
    return old
  }
  const taken = db
    .select({ id: rules.id })
    .from(rules)
    .where(and(eq(rules.match_type, match_type), eq(rules.pattern, pattern), ne(rules.id, ruleId)))
    .get()
  if (taken !== undefined) throw new ConflictError(`A ${match_type} rule for ${pattern} already exists`)

  return db.transaction(() => {
    const rule = db
      .update(rules)
      .set({ match_type, pattern, category_id, essentiality })
      .where(eq(rules.id, ruleId))
      .returning()
      .get()
    // After the update: keys an exact rule holds, the new version included, are spared; the
    // new version's own entry is rewritten next anyway.
    removeCacheRows(db, old)
    if (match_type === 'exact') writeCacheEntry(db, pattern, category_id, essentiality)
    applyRule(db, rule)
    return rule
  })
}

export function deleteRule(db: Db, ruleId: number): void {
  const rule = db.select().from(rules).where(eq(rules.id, ruleId)).get()
  if (rule === undefined) throw new NotFoundError(`Rule ${ruleId} not found`)
  db.transaction(() => {
    db.delete(rules).where(eq(rules.id, ruleId)).run()
    removeCacheRows(db, rule)
  })
}

/** Delete the manual cache rows a rule may have written (cacheKeysOf). */
function removeCacheRows(db: Db, rule: Rule): void {
  for (const key of cacheKeysOf(db, rule)) {
    db.delete(merchantClassifications)
      .where(and(eq(merchantClassifications.merchant_key, key), eq(merchantClassifications.source, 'manual')))
      .run()
  }
}

/**
 * The manual cache keys a rule may have written: its pattern; for a prefix rule, keys starting
 * with it; for a contains rule, the keys of transactions it matches. Keys another exact rule
 * still holds are kept. Call after the rule itself is deleted or changed.
 */
function cacheKeysOf(db: Db, rule: Rule): string[] {
  const held = new Set(
    db
      .select({ pattern: rules.pattern })
      .from(rules)
      .where(eq(rules.match_type, 'exact'))
      .all()
      .map((r) => r.pattern),
  )
  const matched = new Set<string>([rule.pattern])
  if (rule.match_type === 'contains') {
    const rows = db
      .select({ key: transactions.merchant_key, raw: transactions.raw_description })
      .from(transactions)
      .where(isNotNull(transactions.merchant_key))
      .all()
    for (const row of rows) if (row.key && containsPattern(row.raw, rule.pattern)) matched.add(row.key)
  }
  const manual = db
    .select({ key: merchantClassifications.merchant_key })
    .from(merchantClassifications)
    .where(eq(merchantClassifications.source, 'manual'))
    .all()
    .map((r) => r.key)
  return manual.filter(
    (key) => !held.has(key) && (matched.has(key) || (rule.match_type === 'prefix' && key.startsWith(rule.pattern))),
  )
}
