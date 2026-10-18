import { useState } from 'react'
import type { Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useUnpairTransfer } from './queries'

/** "Unpair" on a paired transfer, behind a short confirm: both sides count as spending or income again. */
export function UnpairTransfer({ txn, label }: { txn: Schemas['TransactionRead']; label: string }) {
  const unpair = useUnpairTransfer()
  const [open, setOpen] = useState(false)

  function onOpenChange(next: boolean) {
    if (next) unpair.reset()
    setOpen(next)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={<Button size="xs" variant="ghost" className="shrink-0 text-muted-foreground" aria-label={`Unpair ${label}`} />}
      >
        Unpair
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 text-sm">
        <p>Not a transfer? Both sides will count as spending or income again.</p>
        {unpair.isError && (
          <p role="alert" className="text-xs text-destructive">
            {unpair.error.message}
          </p>
        )}
        <div className="flex gap-2">
          <Button size="sm" disabled={unpair.isPending} onClick={() => unpair.mutate(txn.id, { onSuccess: () => setOpen(false) })}>
            Unpair transfer
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
