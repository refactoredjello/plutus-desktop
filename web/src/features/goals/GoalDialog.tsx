import { useState, type FormEvent } from 'react'
import type { Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useGoalMutations } from './queries'

type Goal = Schemas['GoalRead']

function GoalForm({ goal, onDone }: { goal: Goal | null; onDone: () => void }) {
  const { create, update } = useGoalMutations()
  const [name, setName] = useState(goal?.name ?? '')
  const [amount, setAmount] = useState(goal ? String(Number(goal.target_amount)) : '')
  const [date, setDate] = useState(goal?.target_date ?? '')
  const mutation = goal ? update : create
  const valid = name.trim() !== '' && Number(amount) > 0 && date !== ''

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!valid) return
    const body = { name: name.trim(), target_amount: String(Number(amount)), target_date: date }
    if (goal) update.mutate({ id: goal.id, body }, { onSuccess: onDone })
    else create.mutate(body, { onSuccess: onDone })
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="goal-name">Name</Label>
        <Input id="goal-name" maxLength={255} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="goal-amount">Target amount</Label>
          <Input
            id="goal-amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="goal-date">Target date</Label>
          <Input id="goal-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
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
          {goal ? 'Save' : 'Create goal'}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Create (goal = null) or edit a goal. */
export function GoalDialog({ open, goal, onClose }: { open: boolean; goal: Goal | null; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{goal ? 'Edit goal' : 'New goal'}</DialogTitle>
          <DialogDescription>What you are saving for, how much, and by when.</DialogDescription>
        </DialogHeader>
        <GoalForm goal={goal} onDone={onClose} />
      </DialogContent>
    </Dialog>
  )
}
