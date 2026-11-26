import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/toast'

const count = (n: number, one: string, many = one) => `${n} ${n === 1 ? one : many}`

/** What a recalculation changed, in a few words. */
export function refreshSummary(r: Schemas['RecalculateRead']): string {
  const parts = [
    r.recategorized > 0 && count(r.recategorized, 'recategorized'),
    r.categorized > 0 && count(r.categorized, 'newly categorized'),
    r.recurring_changes > 0 && count(r.recurring_changes, 'recurring change', 'recurring changes'),
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'Everything is up to date'
}

/** Recalculate locally (rules, merchant cache, recurring; no bank, no LLM), then refetch every view. */
export function RefreshButton() {
  const qc = useQueryClient()
  const refresh = useMutation({
    mutationFn: () => unwrap(api.POST('/api/recalculate')),
    onSuccess: (result) => {
      notify(refreshSummary(result))
      return qc.invalidateQueries()
    },
    meta: { errorTitle: 'Refresh failed' },
  })
  return (
    <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
      {refresh.isPending ? 'Refreshing...' : 'Refresh'}
    </Button>
  )
}
