import { CalendarOff } from 'lucide-react'
import type { Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useUpdateTransaction } from './queries'

/** Icon button that marks an expense as one-time, so the projection's trailing average skips it. */
export function OneTimeToggle({ txn, label }: { txn: Schemas['TransactionRead']; label: string }) {
  const save = useUpdateTransaction()
  const on = txn.one_time
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      className={cn(
        'shrink-0 text-muted-foreground',
        // Same hover behaviour as the note button: quiet on desktop until the row is hovered.
        !on && 'sm:opacity-0 sm:group-hover/row:opacity-100 sm:focus-visible:opacity-100',
        on && 'text-foreground',
      )}
      aria-pressed={on}
      aria-label={on ? `Unmark ${label} as one-time` : `Mark ${label} as one-time`}
      title={on ? 'One-time: left out of the projection' : 'Mark as one-time'}
      disabled={save.isPending}
      onClick={() => save.mutate({ id: txn.id, body: { one_time: !on } })}
    >
      <CalendarOff aria-hidden />
    </Button>
  )
}
