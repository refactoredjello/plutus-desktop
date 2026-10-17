/**
 * Drizzle tables, one per SQLAlchemy model in api/app/models (plan section 5.4).
 *
 * Table names, column names and order, nullability, unique constraints, indexes and their
 * names, and ON DELETE behaviour match the final state of Alembic migrations 0001 to 0006, so
 * a Postgres export imports without renaming. Column keys are the snake_case column names, so
 * rows read like the Python model attributes and the wire format.
 *
 * Where SQLite forces a different representation:
 * - NUMERIC(14,2) money is INTEGER cents through the `money` column type.
 * - DATE is TEXT "YYYY-MM-DD"; TIMESTAMPTZ is TEXT ISO 8601 UTC with milliseconds.
 * - BOOLEAN is INTEGER 0/1 (Drizzle boolean mode).
 * - VARCHAR(n) and CHAR(3) are TEXT; SQLite does not enforce the lengths.
 * - Enums stay text validated in code, as the Python app stores them as VARCHAR(20).
 * - Integer keys use AUTOINCREMENT so ids are never reused, like a Postgres sequence.
 * - Primary key constraint names (pk_<table>) are not kept; SQLite cannot name a rowid key.
 *
 * Defaults: SQLAlchemy `default=` values are client-side, so they are `$defaultFn` here and not
 * in the DDL; `server_default` values (now(), 0, false) are SQL defaults, as in Postgres.
 */

import { sql } from 'drizzle-orm'
import {
  customType,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core'
import { type PlainDate, utcNow } from '../lib/dates.js'
import { type Cents, cents } from '../lib/money.js'

// Enums from api/app/models/base.py.
export const ACCOUNT_TYPES = ['checking', 'savings', 'credit', 'loan', 'other'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const ESSENTIALITIES = ['essential', 'flexible', 'discretionary'] as const
export type Essentiality = (typeof ESSENTIALITIES)[number]

/** Query filter: one of the essentiality values, or `unset` for none (incl. uncategorized). */
export const ESSENTIALITY_FILTERS = [...ESSENTIALITIES, 'unset'] as const
export type EssentialityFilter = (typeof ESSENTIALITY_FILTERS)[number]

export const CLASSIFICATION_SOURCES = ['rule', 'cache', 'llm', 'manual'] as const
export type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number]

/** Mirrors Plaid's confidence levels. */
export const CONFIDENCES = ['very_high', 'high', 'medium', 'low', 'unknown'] as const
export type Confidence = (typeof CONFIDENCES)[number]

/**
 * exact: merchant_key equals pattern; prefix: merchant_key starts with pattern;
 * contains: raw description contains pattern (local only, never sent to an LLM).
 */
export const RULE_MATCH_TYPES = ['exact', 'prefix', 'contains'] as const
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number]

/** semimonthly: twice a month on roughly fixed days, e.g. the 15th and month end. */
export const CADENCES = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'yearly'] as const
export type Cadence = (typeof CADENCES)[number]

export const RECURRENCES = ['none', 'weekly', 'biweekly', 'monthly', 'yearly'] as const
export type Recurrence = (typeof RECURRENCES)[number]

export const RECURRENCE_STATUSES = ['proposed', 'confirmed', 'dismissed'] as const
export type RecurrenceStatus = (typeof RECURRENCE_STATUSES)[number]

export const SUGGESTION_STATUSES = ['open', 'kept', 'dismissed'] as const
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number]

export const SYNC_TRIGGERS = ['scheduled', 'manual'] as const
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number]

export const SYNC_STATUSES = ['running', 'success', 'error'] as const
export type SyncStatus = (typeof SYNC_STATUSES)[number]

/** NUMERIC(14,2) as INTEGER cents. Refuses anything that is not an integer. */
export const money = customType<{ data: Cents; driverData: number }>({
  dataType: () => 'integer',
  toDriver: (value) => {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`Money must be integer cents, got ${String(value)}`)
    }
    return value
  },
  fromDriver: (value) => cents(value),
})

/** server_default=func.now(), rendered as ISO 8601 UTC like new Date().toISOString(). */
const NOW = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

const date = (name: string) => text(name).$type<PlainDate>()
const timestamp = (name: string) => text(name)
const bool = (name: string) => integer(name, { mode: 'boolean' })
const id = () => integer('id').primaryKey({ autoIncrement: true })

/** TimestampMixin. */
const timestamps = () => ({
  created_at: timestamp('created_at').notNull().default(NOW),
  updated_at: timestamp('updated_at')
    .notNull()
    .default(NOW)
    .$onUpdate(() => utcNow()),
})

// models/account.py

export const accounts = sqliteTable(
  'accounts',
  {
    id: id(),
    provider: text('provider').notNull(),
    external_id: text('external_id').notNull(),
    name: text('name').notNull(),
    type: text('type', { enum: ACCOUNT_TYPES })
      .notNull()
      .$defaultFn(() => 'other'),
    institution_name: text('institution_name'),
    currency: text('currency')
      .notNull()
      .$defaultFn(() => 'USD'),
    is_active: bool('is_active')
      .notNull()
      .$defaultFn(() => true),
    ...timestamps(),
  },
  (t) => [unique('uq_accounts_provider').on(t.provider, t.external_id)],
)

export const balanceSnapshots = sqliteTable(
  'balance_snapshots',
  {
    id: id(),
    account_id: integer('account_id').notNull(),
    balance: money('balance').notNull(),
    available: money('available'),
    as_of: timestamp('as_of').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'fk_balance_snapshots_account_id_accounts',
      columns: [t.account_id],
      foreignColumns: [accounts.id],
    }).onDelete('cascade'),
    index('ix_balance_snapshots_account_as_of').on(t.account_id, t.as_of),
  ],
)

// models/category.py

/** Seeded from Plaid's Personal Finance Categories (primary + detailed). */
export const categories = sqliteTable(
  'categories',
  {
    id: id(),
    primary: text('primary').notNull(),
    detailed: text('detailed').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    is_hidden: bool('is_hidden')
      .notNull()
      .$defaultFn(() => false),
    is_custom: bool('is_custom')
      .notNull()
      .$defaultFn(() => false),
  },
  (t) => [unique('uq_categories_detailed').on(t.detailed)],
)

/** Cache of classifications per normalized merchant key. The LLM is asked once per key. */
export const merchantClassifications = sqliteTable(
  'merchant_classifications',
  {
    merchant_key: text('merchant_key').primaryKey(),
    category_id: integer('category_id').notNull(),
    essentiality: text('essentiality', { enum: ESSENTIALITIES }),
    confidence: text('confidence', { enum: CONFIDENCES }).notNull(),
    source: text('source', { enum: CLASSIFICATION_SOURCES }).notNull(),
    updated_at: timestamp('updated_at')
      .notNull()
      .default(NOW)
      .$onUpdate(() => utcNow()),
  },
  (t) => [
    foreignKey({
      name: 'fk_merchant_classifications_category_id_categories',
      columns: [t.category_id],
      foreignColumns: [categories.id],
    }),
  ],
)

/** Owner-defined rules. Always win over cache and LLM. */
export const rules = sqliteTable(
  'rules',
  {
    id: id(),
    match_type: text('match_type', { enum: RULE_MATCH_TYPES }).notNull(),
    pattern: text('pattern').notNull(),
    category_id: integer('category_id').notNull(),
    essentiality: text('essentiality', { enum: ESSENTIALITIES }),
    created_at: timestamp('created_at').notNull().default(NOW),
  },
  (t) => [
    foreignKey({
      name: 'fk_rules_category_id_categories',
      columns: [t.category_id],
      foreignColumns: [categories.id],
    }),
    unique('uq_rules_match_type').on(t.match_type, t.pattern),
  ],
)

// models/planning.py

/** v1 goal type: save target_amount by target_date. */
export const goals = sqliteTable('goals', {
  id: id(),
  name: text('name').notNull(),
  target_amount: money('target_amount').notNull(),
  target_date: date('target_date').notNull(),
  starting_amount: money('starting_amount').notNull(),
  is_active: bool('is_active')
    .notNull()
    .$defaultFn(() => true),
  ...timestamps(),
})

// models/system.py

export const syncRuns = sqliteTable('sync_runs', {
  id: id(),
  provider: text('provider').notNull(),
  trigger: text('trigger', { enum: SYNC_TRIGGERS }).notNull(),
  status: text('status', { enum: SYNC_STATUSES })
    .notNull()
    .$defaultFn(() => 'running'),
  started_at: timestamp('started_at').notNull().default(NOW),
  finished_at: timestamp('finished_at'),
  added: integer('added')
    .notNull()
    .$defaultFn(() => 0),
  updated: integer('updated')
    .notNull()
    .$defaultFn(() => 0),
  error_text: text('error_text'),
  /** Provider HTTP requests this run made; the daily budget guard sums these. */
  requests: integer('requests').notNull().default(0),
})

/** Key/value store. Encrypted values (e.g. the SimpleFIN access URL) use the SecretStore. */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  is_encrypted: bool('is_encrypted')
    .notNull()
    .$defaultFn(() => false),
  updated_at: timestamp('updated_at')
    .notNull()
    .default(NOW)
    .$onUpdate(() => utcNow()),
})

/** A dismissed "What changed" item (R12.6). Keyed by the fact, so a new fact reappears. */
export const changeDismissals = sqliteTable('change_dismissals', {
  key: text('key').primaryKey(),
  signal: text('signal').notNull(),
  dismissed_at: timestamp('dismissed_at').notNull().default(NOW),
})

// models/transaction.py

/** Amount sign: negative is money leaving the account, positive is money arriving. */
export const transactions = sqliteTable(
  'transactions',
  {
    id: id(),
    account_id: integer('account_id').notNull(),
    external_id: text('external_id').notNull(),
    posted_on: date('posted_on').notNull(),
    transacted_at: timestamp('transacted_at'),
    amount: money('amount').notNull(),
    raw_description: text('raw_description').notNull(),
    payee: text('payee'),
    memo: text('memo'),
    pending: bool('pending')
      .notNull()
      .$defaultFn(() => false),
    merchant_key: text('merchant_key'),
    is_transfer: bool('is_transfer')
      .notNull()
      .$defaultFn(() => false),
    transfer_pair_id: integer('transfer_pair_id'),
    ...timestamps(),
    /** The owner's own free-text context. Never sent to an LLM. */
    note: text('note'),
    /**
     * Owner-marked one-off (a fine, a big medical bill): still spending, but left out of the
     * trailing average that drives the projection.
     */
    one_time: bool('one_time').notNull().default(false),
  },
  (t) => [
    foreignKey({
      name: 'fk_transactions_account_id_accounts',
      columns: [t.account_id],
      foreignColumns: [accounts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_transactions_transfer_pair_id_transactions',
      columns: [t.transfer_pair_id],
      foreignColumns: [t.id],
    }).onDelete('set null'),
    unique('uq_transactions_account_id').on(t.account_id, t.external_id),
    index('ix_transactions_merchant_key').on(t.merchant_key),
    index('ix_transactions_posted_on').on(t.posted_on),
  ],
)

export const categorizations = sqliteTable(
  'categorizations',
  {
    transaction_id: integer('transaction_id').primaryKey(),
    category_id: integer('category_id').notNull(),
    essentiality: text('essentiality', { enum: ESSENTIALITIES }),
    source: text('source', { enum: CLASSIFICATION_SOURCES }).notNull(),
    confidence: text('confidence', { enum: CONFIDENCES })
      .notNull()
      .$defaultFn(() => 'unknown'),
    // No server default in Python: the service sets it.
    updated_at: timestamp('updated_at').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'fk_categorizations_category_id_categories',
      columns: [t.category_id],
      foreignColumns: [categories.id],
    }),
    foreignKey({
      name: 'fk_categorizations_transaction_id_transactions',
      columns: [t.transaction_id],
      foreignColumns: [transactions.id],
    }).onDelete('cascade'),
  ],
)

/** Expected income (positive) or expense (negative) not yet in bank data. */
export const manualEntries = sqliteTable(
  'manual_entries',
  {
    id: id(),
    amount: money('amount').notNull(),
    description: text('description').notNull(),
    category_id: integer('category_id'),
    due_date: date('due_date').notNull(),
    recurrence: text('recurrence', { enum: RECURRENCES })
      .notNull()
      .$defaultFn(() => 'none'),
    end_date: date('end_date'),
    fulfilled_transaction_id: integer('fulfilled_transaction_id'),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'fk_manual_entries_category_id_categories',
      columns: [t.category_id],
      foreignColumns: [categories.id],
    }),
    foreignKey({
      name: 'fk_manual_entries_fulfilled_transaction_id_transactions',
      columns: [t.fulfilled_transaction_id],
      foreignColumns: [transactions.id],
    }).onDelete('set null'),
  ],
)

/** A detected or confirmed recurring income or expense (RecurringCharge). */
export const recurrences = sqliteTable(
  'recurrences',
  {
    id: id(),
    merchant_key: text('merchant_key').notNull(),
    account_id: integer('account_id').notNull(),
    amount: money('amount').notNull(),
    cadence: text('cadence', { enum: CADENCES }).notNull(),
    next_expected_date: date('next_expected_date').notNull(),
    last_seen_on: date('last_seen_on'),
    status: text('status', { enum: RECURRENCE_STATUSES })
      .notNull()
      .$defaultFn(() => 'proposed'),
    essentiality: text('essentiality', { enum: ESSENTIALITIES }),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'fk_recurrences_account_id_accounts',
      columns: [t.account_id],
      foreignColumns: [accounts.id],
    }).onDelete('cascade'),
    unique('uq_recurrences_merchant_key').on(t.merchant_key, t.account_id),
  ],
)

export const suggestions = sqliteTable(
  'suggestions',
  {
    id: id(),
    goal_id: integer('goal_id').notNull(),
    text: text('text').notNull(),
    category_id: integer('category_id'),
    estimated_monthly_saving: money('estimated_monthly_saving'),
    status: text('status', { enum: SUGGESTION_STATUSES })
      .notNull()
      .$defaultFn(() => 'open'),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'fk_suggestions_category_id_categories',
      columns: [t.category_id],
      foreignColumns: [categories.id],
    }),
    foreignKey({
      name: 'fk_suggestions_goal_id_goals',
      columns: [t.goal_id],
      foreignColumns: [goals.id],
    }).onDelete('cascade'),
  ],
)
