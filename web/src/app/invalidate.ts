import type { QueryClient } from '@tanstack/react-query'

/**
 * Queries computed from categorizations, rules, and recurring flags. Every report is computed
 * live on the server, so refetching these is enough for an edit to show everywhere.
 * ['reports'] covers the month view and What changed too.
 */
const DERIVED_KEYS = [['transactions'], ['reports'], ['projection'], ['recurring'], ['goals']] as const

/** Refetch everything an edit to a transaction, rule, or recurring charge can change. */
export function invalidateDerived(qc: QueryClient) {
  return Promise.all(DERIVED_KEYS.map((queryKey) => qc.invalidateQueries({ queryKey })))
}
