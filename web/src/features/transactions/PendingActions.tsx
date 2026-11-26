import { useState } from 'react'
import type { Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { notify } from '@/lib/toast'
import { useMarkPosted, useRemovePending } from './queries'

type Txn = Schemas['TransactionRead']

/**
 * For a pending transaction the bank may never settle: "Mark as posted" counts it in totals,
 * "Remove" (behind a confirm) deletes a hold that never became a charge. Errors are toasted by
 * the query client.
 */
export function PendingActions({ txn, onPosted, onRemoved }: { txn: Txn; onPosted: (t: Txn) => void; onRemoved: () => void }) {
  const markPosted = useMarkPosted()
  const remove = useRemovePending()
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="grid gap-2 text-sm">
      <p className="text-muted-foreground">
        {txn.review_reason ? <span className="font-medium text-foreground">{txn.review_reason}</span> : 'Pending at the bank.'}{' '}
        Pending charges count in no total until they post.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={markPosted.isPending}
          onClick={() =>
            markPosted.mutate(txn.id, {
              onSuccess: (posted) => {
                onPosted(posted)
                notify('Marked as posted')
              },
            })
          }
        >
          Mark as posted
        </Button>
        <Popover open={confirming} onOpenChange={setConfirming}>
          <PopoverTrigger render={<Button size="sm" variant="ghost" />}>Remove</PopoverTrigger>
          <PopoverContent align="start" className="w-64 text-sm">
            <p>Remove this pending charge? Use this for a hold that never became a charge.</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(txn.id, {
                    onSuccess: () => {
                      setConfirming(false)
                      onRemoved()
                      notify('Transaction removed')
                    },
                  })
                }
              >
                Remove transaction
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
