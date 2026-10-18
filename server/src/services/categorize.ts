/**
 * Categorization pipeline (R3): rules, then cache, then LLM.
 *
 * Called by services/sync.ts after transfer matching. Keep the signature stable.
 *
 * - better-sqlite3 is synchronous and nothing may be awaited inside a transaction, so the work
 *   before the LLM (merchant keys, transfers, rules, cache) is written in one transaction, and
 *   each LLM batch in its own once its answer is in. A failing LLM still leaves the earlier work in place.
 * - The owner name tokens and the provider come from the config service (runtimeConfig and
 *   llmProvider), never from the environment.
 * - Contains rules compare with full case folding; applying a rule to past transactions (and
 *   transaction search) match with a simple lowercase mapping. JavaScript has neither and
 *   SQLite's lower() is ASCII-only: see casefold and simpleLower.
 * - Keys sort by code point; JavaScript's default sort compares UTF-16 units.
 */

import { type Column, and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { RuntimeDefaults } from '../config.js'
import type { Db } from '../db/index.js'
import {
  type AccountType,
  type ClassificationSource,
  type Confidence,
  type Essentiality,
  accounts,
  categories,
  categorizations,
  merchantClassifications,
  rules,
  transactions,
} from '../db/schema.js'
import { utcNow } from '../lib/dates.js'
import { type Logger, silentLogger } from '../lib/log.js'
import type { LLMProvider, MerchantClassification as LLMClassification, MerchantInput } from '../providers/llm/types.js'
import type { SecretStore } from '../secrets.js'
import { llmProvider, runtimeConfig } from './config.js'
import { buildMerchantInput, merchantKey } from './scrub.js'

export const BATCH_SIZE = 50
export const FALLBACK_CATEGORY = 'OTHER_OTHER'

type Tx = typeof transactions.$inferSelect
export type Rule = typeof rules.$inferSelect

/** Printable ASCII, where every case mapping below is plain toLowerCase. */
const ASCII = /^[ -~]*$/

/**
 * Full case folding (Unicode 16). Per code point, uppercasing then lowercasing is full case
 * folding except for the cases below, checked over every code point; characters Unicode 17
 * added are not folded. One code point at a time, so JavaScript's final-sigma rule never
 * applies.
 */
export function casefold(text: string): string {
  if (ASCII.test(text)) return text.toLowerCase()
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number
    if (cp === 0x131) out += ch // dotless i has no folding
    else if (cp === 0x1e9e) out += 'ss' // capital sharp s
    else if ((cp >= 0x13a0 && cp <= 0x13fd) || (cp >= 0xab70 && cp <= 0xabbf)) out += ch.toUpperCase() // Cherokee folds to uppercase
    else out += ch.toUpperCase().toLowerCase()
  }
  return out
}

/**
 * Lowercase one code point at a time with the simple lowercase mapping, as musl's towlower
 * does: U+0130 becomes a plain "i" and circled letters stay as they are. Used for
 * case-insensitive matching in SQL, where lower() is ASCII-only.
 */
export function simpleLower(text: string): string {
  if (ASCII.test(text)) return text.toLowerCase()
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number
    if (cp === 0x130) out += 'i' // simple mapping, not "i" plus a combining dot
    else if (cp >= 0x24b6 && cp <= 0x24cf) out += ch // musl leaves circled letters alone
    else out += ch.toLowerCase()
  }
  return out
}

const withPgLower = new WeakSet<object>()

/**
 * Register `simple_lower(text)` on the connection, so SQL can match a substring
 * case-insensitively beyond ASCII.
 */
export function ensurePgLower(db: Db): void {
  if (withPgLower.has(db.$client)) return
  db.$client.function('simple_lower', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? simpleLower(value) : value,
  )
  withPgLower.add(db.$client)
}

/** A literal (no wildcards), case-insensitive substring match on a column. */
export function icontains(column: Column, text: string) {
  return sql`instr(simple_lower(${column}), ${simpleLower(text)}) > 0`
}

/** String ordering by code point. */
export function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0) as number)
  const y = Array.from(b, (c) => c.codePointAt(0) as number)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] as number) - (y[i] as number)
    if (d !== 0) return d
  }
  return x.length - y.length
}

/** len(text): code points, not UTF-16 units. */
const pyLen = (text: string): number => Array.from(text).length

/**
 * Set merchant_key and a categorization on every transaction that lacks one.
 *
 * Order: transfers, owner rules (exact, contains, prefix), cached merchant classifications,
 * then the LLM for keys never seen before. A failing LLM leaves its transactions
 * uncategorized; it never throws.
 * Returns the number of transactions categorized.
 */
export async function categorizePending(
  db: Db,
  secrets: SecretStore,
  defaults: RuntimeDefaults,
  provider: LLMProvider | null = null,
  log: Logger = silentLogger(),
): Promise<number> {
  const pending = db
    .select({ tx: transactions })
    .from(transactions)
    .leftJoin(categorizations, eq(categorizations.transaction_id, transactions.id))
    .where(isNull(categorizations.transaction_id))
    .orderBy(asc(transactions.id))
    .all()
    .map((row) => row.tx)
  if (pending.length === 0) return 0

  const { ownerNameTokens } = runtimeConfig(db, secrets, defaults)
  const keys = new Map(pending.map((tx) => [tx.id, merchantKey(tx.raw_description, ownerNameTokens)]))
  const keyOf = (tx: Tx): string => keys.get(tx.id) ?? ''

  const categoryIds = new Map(
    db
      .select({ detailed: categories.detailed, id: categories.id })
      .from(categories)
      .all()
      .map((c) => [c.detailed, c.id]),
  )
  const accountTypes = new Map(
    db
      .select({ id: accounts.id, type: accounts.type })
      .from(accounts)
      .all()
      .map((a) => [a.id, a.type]),
  )
  const pipeline = new Pipeline(db, categoryIds)
  const unseen: Tx[] = []

  db.transaction(() => {
    for (const tx of pending) {
      // Write only what changed, so unchanged rows keep updated_at.
      if (tx.merchant_key !== keyOf(tx)) {
        db.update(transactions).set({ merchant_key: keyOf(tx) }).where(eq(transactions.id, tx.id)).run()
      }
    }

    const unresolved: Tx[] = []
    for (const tx of pending) {
      if (tx.is_transfer) pipeline.assignTransfer(tx, accountTypes)
      else unresolved.push(tx)
    }

    const ruleSet = new Rules(db.select().from(rules).all())
    const afterRules: Tx[] = []
    for (const tx of unresolved) {
      const rule = ruleSet.match(keyOf(tx), tx.raw_description)
      if (rule === undefined) afterRules.push(tx)
      else pipeline.assign(tx, rule.category_id, rule.essentiality, 'rule', 'very_high')
    }

    // Read the table and look keys up, rather than `WHERE merchant_key IN (keys)`, to stay
    // clear of SQLite's bound-parameter limit.
    const wanted = new Set(afterRules.map(keyOf).filter((k) => k))
    const cache = new Map(
      db
        .select()
        .from(merchantClassifications)
        .all()
        .filter((c) => wanted.has(c.merchant_key))
        .map((c) => [c.merchant_key, c]),
    )
    for (const tx of afterRules) {
      const entry = cache.get(keyOf(tx))
      if (entry === undefined) unseen.push(tx)
      else pipeline.assign(tx, entry.category_id, entry.essentiality, 'cache', entry.confidence)
    }
  })

  if (unseen.length) {
    await classifyUnseen(db, secrets, defaults, provider, pipeline, unseen, keyOf, accountTypes, log)
  }
  return pipeline.count
}

async function classifyUnseen(
  db: Db,
  secrets: SecretStore,
  defaults: RuntimeDefaults,
  provider: LLMProvider | null,
  pipeline: Pipeline,
  unseen: readonly Tx[],
  keyOf: (tx: Tx) => string,
  accountTypes: ReadonlyMap<number, AccountType>,
  log: Logger,
): Promise<void> {
  const byKey = new Map<string, Tx[]>()
  for (const tx of unseen) {
    const list = byKey.get(keyOf(tx))
    if (list === undefined) byKey.set(keyOf(tx), [tx])
    else list.push(tx)
  }
  const inputs = [...byKey.entries()]
    .sort(([a], [b]) => compareCodePoints(a, b))
    .map(([key, txs]) => {
      const first = txs[0] as Tx
      return buildMerchantInput(key, first.amount, accountTypes.get(first.account_id) ?? 'other')
    })

  try {
    const llm = provider ?? llmProvider(db, secrets, defaults, log)
    for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
      const chunk = inputs.slice(start, start + BATCH_SIZE)
      const results = resultsByKey(await llm.classifyMerchants([...chunk]), chunk)
      const before = pipeline.count
      try {
        db.transaction(() => {
          for (const item of chunk) {
            const result = results.get(item.merchant_key)
            if (result === undefined) continue // model skipped it; stays uncategorized and is retried next sync
            const [categoryId, confidence] = pipeline.resolveCategory(result)
            db.insert(merchantClassifications)
              .values({
                merchant_key: item.merchant_key,
                category_id: categoryId,
                essentiality: result.essentiality,
                confidence,
                source: 'llm',
              })
              .run()
            for (const tx of byKey.get(item.merchant_key) ?? []) {
              pipeline.assign(tx, categoryId, result.essentiality, 'llm', confidence)
            }
          }
        })
      } catch (err) {
        pipeline.count = before // the batch rolled back
        throw err
      }
    }
  } catch (err) {
    log.error({ err, pending: byKey.size }, 'llm_categorization_failed')
  }
}

/** _by_key: answers for requested keys only; a repeated key keeps its last answer. */
function resultsByKey(results: readonly LLMClassification[], requested: readonly MerchantInput[]): Map<string, LLMClassification> {
  const wanted = new Set(requested.map((i) => i.merchant_key))
  const out = new Map<string, LLMClassification>()
  for (const r of results) if (wanted.has(r.merchant_key)) out.set(r.merchant_key, r)
  return out
}

/** Writes categorization rows and counts them. */
class Pipeline {
  count = 0
  private readonly db: Db
  private readonly categoryIds: ReadonlyMap<string, number>

  constructor(db: Db, categoryIds: ReadonlyMap<string, number>) {
    this.db = db
    this.categoryIds = categoryIds
  }

  assign(
    tx: Tx,
    categoryId: number,
    essentiality: Essentiality | null,
    source: ClassificationSource,
    confidence: Confidence,
  ): void {
    this.db
      .insert(categorizations)
      .values({ transaction_id: tx.id, category_id: categoryId, essentiality, source, confidence, updated_at: utcNow() })
      .run()
    this.count += 1
  }

  /** Map an LLM answer to a stored category; unknown names fall back to OTHER_OTHER, low. */
  resolveCategory(result: LLMClassification): [number, Confidence] {
    const categoryId = this.categoryIds.get(result.detailed_category)
    if (categoryId !== undefined) return [categoryId, result.confidence]
    return [this.category(FALLBACK_CATEGORY), 'low']
  }

  assignTransfer(tx: Tx, accountTypes: ReadonlyMap<number, AccountType>): void {
    const inbound = tx.amount > 0
    const other = tx.transfer_pair_id
      ? this.db
          .select({ account_id: transactions.account_id })
          .from(transactions)
          .where(eq(transactions.id, tx.transfer_pair_id))
          .get()
      : undefined
    let detailed: string
    if (inbound) {
      const toSavings = accountTypes.get(tx.account_id) === 'savings'
      detailed = toSavings ? 'TRANSFER_IN_SAVINGS' : 'TRANSFER_IN_ACCOUNT_TRANSFER'
    } else {
      const toSavings = other !== undefined && accountTypes.get(other.account_id) === 'savings'
      detailed = toSavings ? 'TRANSFER_OUT_SAVINGS' : 'TRANSFER_OUT_ACCOUNT_TRANSFER'
    }
    this.assign(tx, this.category(detailed), null, 'rule', 'high')
  }

  /** The id of a seeded category; an unknown slug is a programming error. */
  private category(detailed: string): number {
    const id = this.categoryIds.get(detailed)
    if (id === undefined) throw new Error(`KeyError: '${detailed}'`)
    return id
  }
}

/** Exact beats contains beats prefix. Among contains and prefix rules the longest wins. */
class Rules {
  private readonly exact: Map<string, Rule>
  private readonly contains: Rule[]
  private readonly prefix: Rule[]

  constructor(all: readonly Rule[]) {
    this.exact = new Map(all.filter((r) => r.match_type === 'exact').map((r) => [r.pattern, r]))
    this.contains = Rules.longestFirst(all, 'contains')
    this.prefix = Rules.longestFirst(all, 'prefix')
  }

  private static longestFirst(all: readonly Rule[], matchType: Rule['match_type']): Rule[] {
    return all
      .filter((r) => r.match_type === matchType)
      .map((r) => ({ r, len: pyLen(r.pattern) }))
      .sort((a, b) => b.len - a.len || a.r.id - b.r.id)
      .map(({ r }) => r)
  }

  match(key: string, rawDescription: string): Rule | undefined {
    const exact = this.exact.get(key)
    if (exact !== undefined) return exact
    const haystack = casefold(rawDescription)
    const hit = this.contains.find((r) => haystack.includes(casefold(r.pattern)))
    if (hit !== undefined) return hit
    return this.prefix.find((r) => key.startsWith(r.pattern))
  }
}

/**
 * Re-apply a rule to existing non-transfer transactions whose categorization is not manual.
 *
 * Covers transactions that have no categorization yet. Returns how many were changed.
 * The writes run in one transaction, a savepoint inside a caller's.
 */
export function applyRule(db: Db, rule: Pick<Rule, 'match_type' | 'pattern' | 'category_id' | 'essentiality'>): number {
  ensurePgLower(db)
  const match =
    rule.match_type === 'exact'
      ? eq(transactions.merchant_key, rule.pattern)
      : rule.match_type === 'contains'
        ? icontains(transactions.raw_description, rule.pattern)
        : // startswith(autoescape=True): a literal, case-sensitive prefix (SQLite's LIKE ignores ASCII case).
          sql`substr(${transactions.merchant_key}, 1, length(${rule.pattern})) = ${rule.pattern}`
  const rows = db
    .select({ id: transactions.id, current: categorizations })
    .from(transactions)
    .leftJoin(categorizations, eq(categorizations.transaction_id, transactions.id))
    .where(and(eq(transactions.is_transfer, false), match))
    .all()
  let changed = 0
  db.transaction(() => {
    for (const { id, current } of rows) {
      if (current !== null && current.source === 'manual') continue
      const values = {
        category_id: rule.category_id,
        essentiality: rule.essentiality,
        source: 'rule' as const,
        confidence: 'very_high' as const,
        updated_at: utcNow(),
      }
      if (current === null) db.insert(categorizations).values({ transaction_id: id, ...values }).run()
      else db.update(categorizations).set(values).where(eq(categorizations.transaction_id, id)).run()
      changed += 1
    }
  })
  return changed
}
