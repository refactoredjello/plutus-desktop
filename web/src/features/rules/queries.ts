import { useEffect, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from '@/api/client'
import { invalidateDerived } from '@/app/invalidate'
import { notify } from '@/lib/toast'

type Rule = Schemas['RuleRead']

/**
 * Creates a rule, or saves an edit to `rule` (sent whole; a null essentiality clears it).
 * Either changes categorizations, so transactions refresh with the rule list.
 */
export function useSaveRule(rule: Rule | null | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['RuleCreate']) =>
      rule
        ? unwrap(
            api.PATCH('/api/rules/{rule_id}', {
              params: { path: { rule_id: rule.id } },
              body: { ...body, essentiality: body.essentiality ?? null },
            }),
          )
        : unwrap(api.POST('/api/rules', { body })),
    onSuccess: () => {
      notify(rule ? 'Rule updated' : 'Rule created')
      void qc.invalidateQueries({ queryKey: ['rules'] })
      void invalidateDerived(qc)
    },
    // Both rule forms show the server's complaint next to their fields.
    meta: { inlineError: true },
  })
}

/** The rule that categorizes a transaction, if any, and defaults for a new one. Under ['rules'], so rule edits refetch it. */
export const useTransactionRule = (id: number, enabled: boolean) =>
  useQuery({
    queryKey: ['rules', 'transaction', id],
    queryFn: () =>
      unwrap(api.GET('/api/transactions/{transaction_id}/rule', { params: { path: { transaction_id: id } } })),
    enabled,
  })

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

export const PREVIEW_DEBOUNCE_MS = 300

/** How many transactions a rule would match, refetched a moment after typing stops. */
export function useRulePreview(matchType: Schemas['RuleMatchType'], pattern: string) {
  const text = useDebounced(pattern.trim(), PREVIEW_DEBOUNCE_MS)
  const body = { match_type: matchType, pattern: text }
  return useQuery({
    queryKey: ['rules', 'preview', body.match_type, body.pattern],
    queryFn: () => unwrap(api.POST('/api/rules/preview', { body })),
    enabled: body.pattern !== '',
    placeholderData: keepPreviousData,
  })
}
