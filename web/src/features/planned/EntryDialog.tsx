import { useState, type FormEvent } from 'react'
import type { Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CategorySelect } from '@/features/transactions/selects'
import { useCategories } from '@/features/transactions/queries'
import { humanizeEnum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { usePlannedMutations } from './queries'

type Entry = Schemas['ManualEntryRead']
type Recurrence = Schemas['Recurrence']

const RECURRENCES: Recurrence[] = ['none', 'weekly', 'biweekly', 'monthly', 'yearly']
const recurrenceLabel = (r: Recurrence) => (r === 'none' ? 'Does not repeat' : humanizeEnum(r))
const recurrenceItems = Object.fromEntries(RECURRENCES.map((r) => [r, recurrenceLabel(r)]))

function EntryForm({ entry, onDone }: { entry: Entry | null; onDone: () => void }) {
  const { create, update } = usePlannedMutations()
  const categories = useCategories()
  const [kind, setKind] = useState<'income' | 'expense'>(entry && Number(entry.amount) > 0 ? 'income' : 'expense')
  const [amount, setAmount] = useState(entry ? String(Math.abs(Number(entry.amount))) : '')
  const [description, setDescription] = useState(entry?.description ?? '')
  const [dueDate, setDueDate] = useState(entry?.due_date ?? '')
  const [recurrence, setRecurrence] = useState<Recurrence>(entry?.recurrence ?? 'none')
  const [endDate, setEndDate] = useState(entry?.end_date ?? '')
  const [categoryId, setCategoryId] = useState<number | null>(entry?.category_id ?? null)

  const mutation = entry ? update : create
  const valid = description.trim() !== '' && Number(amount) > 0 && dueDate !== ''

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!valid) return
    const body = {
      amount: (kind === 'expense' ? '-' : '') + String(Number(amount)),
      description: description.trim(),
      due_date: dueDate,
      recurrence,
      end_date: recurrence !== 'none' && endDate ? endDate : null,
      category_id: categoryId,
    }
    if (entry) update.mutate({ id: entry.id, body }, { onSuccess: onDone })
    else create.mutate(body, { onSuccess: onDone })
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div role="group" aria-label="Type" className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        {(['expense', 'income'] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={cn(
              'rounded-md px-3 py-1 text-sm transition-colors',
              kind === k ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground',
            )}
          >
            {humanizeEnum(k)}
          </button>
        ))}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="planned-amount">Amount</Label>
        <Input
          id="planned-amount"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="planned-description">Description</Label>
        <Input
          id="planned-description"
          maxLength={255}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="planned-date">Date</Label>
          <Input id="planned-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Repeats</Label>
          <Select items={recurrenceItems} value={recurrence} onValueChange={(v) => v && setRecurrence(v as Recurrence)}>
            <SelectTrigger aria-label="Repeats" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RECURRENCES.map((r) => (
                <SelectItem key={r} value={r}>
                  {recurrenceLabel(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {recurrence !== 'none' && (
        <div className="space-y-1.5">
          <Label htmlFor="planned-end">End date (optional)</Label>
          <Input id="planned-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
      )}
      <div className="space-y-1.5">
        <Label>Category (optional)</Label>
        <CategorySelect
          categories={(categories.data ?? []).filter((c) => !c.is_hidden || c.id === categoryId)}
          value={categoryId}
          onChange={setCategoryId}
          label="Category"
          allLabel="No category"
        />
      </div>
      {mutation.isError && (
        <p role="alert" className="text-sm text-destructive">
          {mutation.error.message}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || mutation.isPending}>
          {entry ? 'Save' : 'Add'}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Add (entry = null) or edit a planned item. Pass `open={false}` to close. */
export function EntryDialog({ open, entry, onClose }: { open: boolean; entry: Entry | null; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{entry ? 'Edit planned item' : 'Add planned item'}</DialogTitle>
          <DialogDescription>Expected income or an expense that has not hit your accounts yet.</DialogDescription>
        </DialogHeader>
        <EntryForm entry={entry} onDone={onClose} />
      </DialogContent>
    </Dialog>
  )
}
