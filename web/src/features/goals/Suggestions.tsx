import { useState } from 'react'
import { SparklesIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/money'
import { useGenerateSuggestions, useSuggestions, useUpdateSuggestion } from './queries'

export function Suggestions({ goalId }: { goalId: number }) {
  const suggestions = useSuggestions(goalId)
  const generate = useGenerateSuggestions(goalId)
  const update = useUpdateSuggestion(goalId)
  const [showDismissed, setShowDismissed] = useState(false)

  const all = suggestions.data ?? []
  const dismissed = all.filter((s) => s.status === 'dismissed').length
  const visible = all.filter((s) => showDismissed || s.status !== 'dismissed')

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={generate.isPending} onClick={() => generate.mutate()}>
          <SparklesIcon />
          {generate.isPending ? 'Thinking…' : 'Suggest ways to save'}
        </Button>
        {dismissed > 0 && (
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setShowDismissed((v) => !v)}>
            {showDismissed ? 'Hide dismissed' : `Show dismissed (${dismissed})`}
          </Button>
        )}
      </div>
      {visible.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {visible.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
              <div className="min-w-0 text-sm">
                <p className={s.status === 'dismissed' ? 'text-muted-foreground line-through' : undefined}>{s.text}</p>
                {s.estimated_monthly_saving && (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    Save about {formatMoney(s.estimated_monthly_saving)}/month
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1">
                {s.status === 'kept' ? (
                  <span className="px-2 text-xs text-muted-foreground">Kept</span>
                ) : (
                  <Button
                    size="xs"
                    variant="secondary"
                    aria-label={`Keep: ${s.text}`}
                    onClick={() => update.mutate({ id: s.id, status: 'kept' })}
                  >
                    Keep
                  </Button>
                )}
                {s.status !== 'dismissed' && (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Dismiss: ${s.text}`}
                    onClick={() => update.mutate({ id: s.id, status: 'dismissed' })}
                  >
                    Dismiss
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
