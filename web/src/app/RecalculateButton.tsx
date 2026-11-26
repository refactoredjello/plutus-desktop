import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { recalculateParts } from '@/features/sync/queries'
import { notify } from '@/lib/toast'

/** The local-only button's name; one place, as it may still change. */
const RECALCULATE_LABEL = 'Recalc'
const RECALCULATE_PENDING_LABEL = 'Recalculating...'

/** What a recalculation changed, in a few words. */
function recalculateSummary(r: Schemas['RecalculateRead']): string {
  const parts = recalculateParts(r)
  return parts.length ? parts.join(', ') : 'Everything is up to date'
}

/** Recalculate locally (rules, merchant cache, recurring; no bank, no LLM), then refetch every view. */
export function RecalculateButton() {
  const qc = useQueryClient()
  const recalculate = useMutation({
    mutationFn: () => unwrap(api.POST('/api/recalculate')),
    onSuccess: (result) => {
      notify(recalculateSummary(result))
      return qc.invalidateQueries()
    },
    meta: { errorTitle: `${RECALCULATE_LABEL} failed` },
  })
  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0"
      title="Re-apply your rules, categories, and recurring charges to the transactions you have. Does not contact the bank."
      onClick={() => recalculate.mutate()}
      disabled={recalculate.isPending}
    >
      {recalculate.isPending ? RECALCULATE_PENDING_LABEL : RECALCULATE_LABEL}
    </Button>
  )
}
