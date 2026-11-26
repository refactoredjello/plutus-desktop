import { useState } from 'react'
import type { Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { CADENCES, useConfirmedRecurring, useMarkRecurring } from '@/features/recurring/queries'

type Cadence = Schemas['Cadence']

const cadenceItems = Object.fromEntries(CADENCES.map((c) => [c.value, c.label]))

/**
 * Marks this transaction's merchant as recurring (or updates the confirmed item): cadence and
 * whether the amount varies. The button goes disabled once saved, which is the confirmation.
 */
export function RepeatsRow({ txn, name }: { txn: Schemas['TransactionRead']; name: string }) {
  const mark = useMarkRecurring()
  const existing = useConfirmedRecurring(txn.merchant_key, txn.account_id, true)
  // null until the owner picks: then the controls follow the existing item (once loaded).
  const [pickedCadence, setCadence] = useState<Cadence | null>(null)
  const [pickedVaries, setVaries] = useState<boolean | null>(null)
  const cadence = pickedCadence ?? existing?.cadence ?? null
  const varies = pickedVaries ?? existing?.amount_varies ?? false
  const noMerchant = !txn.merchant_key
  const unchanged = existing ? cadence === existing.cadence && varies === existing.amount_varies : false

  function submit() {
    if (!cadence) return
    mark.mutate({ transaction_id: txn.id, cadence, amount_varies: varies })
  }

  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium">Repeats</span>
      <div className="flex flex-wrap items-center gap-3">
        <Select
          items={cadenceItems}
          value={cadence}
          onValueChange={(v) => v && setCadence(v as Cadence)}
          disabled={noMerchant}
        >
          <SelectTrigger size="sm" aria-label={`Repeats for ${name}`} className="w-36">
            <SelectValue placeholder="Not recurring" />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {CADENCES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Not a <label>: Base UI would name the switch from it, over the aria-label. */}
        <div className="flex items-center gap-2 text-sm">
          <Switch
            size="sm"
            checked={varies}
            onCheckedChange={setVaries}
            disabled={noMerchant}
            aria-label={`Amount varies for ${name}`}
          />
          <span aria-hidden>Amount varies</span>
        </div>
        <Button size="sm" variant="secondary" disabled={noMerchant || !cadence || unchanged || mark.isPending} onClick={submit}>
          {existing ? 'Update' : 'Mark as recurring'}
        </Button>
      </div>
      {noMerchant && <p className="text-sm text-muted-foreground">No merchant yet; categorize it first.</p>}
      {mark.isError && (
        <p role="alert" className="text-sm text-destructive">
          {mark.error.message}
        </p>
      )}
    </div>
  )
}
