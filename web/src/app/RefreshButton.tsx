import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { Button } from '@/components/ui/button'

/** Recalculate locally (rules, merchant cache, recurring; no bank, no LLM), then refetch every view. */
export function RefreshButton() {
  const qc = useQueryClient()
  const refresh = useMutation({
    mutationFn: () => unwrap(api.POST('/api/recalculate')),
    onSuccess: () => qc.invalidateQueries(),
  })
  return (
    <div className="ml-auto flex shrink-0 items-center gap-2">
      {refresh.isError && (
        <span role="alert" className="text-xs text-destructive">
          Refresh failed: {refresh.error.message}
        </span>
      )}
      <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
        {refresh.isPending ? 'Refreshing...' : 'Refresh'}
      </Button>
    </div>
  )
}
