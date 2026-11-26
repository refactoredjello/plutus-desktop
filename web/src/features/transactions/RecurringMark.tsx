import { useState } from 'react'
import { Repeat } from 'lucide-react'
import { useNavigate } from 'react-router'
import type { Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CADENCES, cadencePhrase, useConfirmedRecurring, useMarkRecurring } from '@/features/recurring/queries'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'

type Cadence = Schemas['Cadence']

/** Small icon button that opens a popover to mark this transaction's merchant as a recurring charge. */
export function RecurringMark({
  txn,
  label,
}: {
  txn: Schemas['TransactionRead']
  label: string
}) {
  const mark = useMarkRecurring()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const existing = useConfirmedRecurring(txn.merchant_key, txn.account_id, open)
  // null until the user picks: then follow the existing item (once loaded) or default to monthly.
  const [picked, setPicked] = useState<Cadence | null>(null)
  const cadence: Cadence = picked ?? existing?.cadence ?? 'monthly'
  const setCadence = setPicked

  function onOpenChange(next: boolean) {
    if (next) {
      setPicked(null)
      mark.reset()
    }
    setOpen(next)
  }

  function submit() {
    mark.mutate(
      { transaction_id: txn.id, cadence },
      {
        onSuccess: () => {
          setOpen(false)
          notify(`Marked recurring ${cadencePhrase(cadence)}`, { label: 'View', onClick: () => void navigate('/recurring') })
        },
      },
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className={cn(
              'shrink-0 text-muted-foreground',
              // Quiet on desktop until the row is hovered or the button focused; always visible on small screens.
              existing
                ? 'text-foreground'
                : 'sm:opacity-0 sm:group-hover/row:opacity-100 sm:focus-visible:opacity-100 sm:data-popup-open:opacity-100',
            )}
            aria-label={`Mark ${label} as recurring`}
          />
        }
      >
        <Repeat aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-sm font-medium">
            {existing ? `Recurring ${cadencePhrase(existing.cadence)}` : 'Repeats'}
          </legend>
          {CADENCES.map((c) => (
            <label key={c.value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`cadence-${txn.id}`}
                className="accent-primary"
                checked={cadence === c.value}
                onChange={() => setCadence(c.value)}
              />
              {c.label}
            </label>
          ))}
        </fieldset>
        {mark.isError && (
          <p role="alert" className="text-xs text-destructive">
            {mark.error.message}
          </p>
        )}
        <Button size="sm" disabled={mark.isPending} onClick={submit}>
          {existing ? 'Update' : 'Mark as recurring'}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
