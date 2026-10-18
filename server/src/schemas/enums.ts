/**
 * The enums that appear in the API, each registered as its own component. Values come from
 * db/schema.ts, so the table and the API share one list.
 */

import {
  ACCOUNT_TYPES,
  CADENCES,
  CLASSIFICATION_SOURCES,
  CONFIDENCES,
  ESSENTIALITIES,
  ESSENTIALITY_FILTERS,
  RECURRENCES,
  RECURRENCE_STATUSES,
  RULE_MATCH_TYPES,
  SUGGESTION_STATUSES,
  SYNC_STATUSES,
  SYNC_TRIGGERS,
} from '../db/schema.js'
import { enumComponent } from './model.js'

export const AccountType = enumComponent('AccountType', ACCOUNT_TYPES)
export const Essentiality = enumComponent('Essentiality', ESSENTIALITIES)
export const EssentialityFilter = enumComponent(
  'EssentialityFilter',
  ESSENTIALITY_FILTERS,
  'Query filter: one of the essentiality values, or `unset` for none (incl. uncategorized).',
)
export const ClassificationSource = enumComponent('ClassificationSource', CLASSIFICATION_SOURCES)
export const Confidence = enumComponent('Confidence', CONFIDENCES, "Mirrors Plaid's confidence levels.")
export const RuleMatchType = enumComponent('RuleMatchType', RULE_MATCH_TYPES)
export const Cadence = enumComponent('Cadence', CADENCES)
export const Recurrence = enumComponent('Recurrence', RECURRENCES)
export const RecurrenceStatus = enumComponent('RecurrenceStatus', RECURRENCE_STATUSES)
export const SuggestionStatus = enumComponent('SuggestionStatus', SUGGESTION_STATUSES)
export const SyncTrigger = enumComponent('SyncTrigger', SYNC_TRIGGERS)
export const SyncStatus = enumComponent('SyncStatus', SYNC_STATUSES)
