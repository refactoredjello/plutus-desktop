import { useState } from 'react'
import type { Schemas } from '@/api/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { formatDate } from '@/lib/format'
import { formatMoney } from '@/lib/money'
import { useGoalMutations } from './queries'
import { Suggestions } from './Suggestions'

type Goal = Schemas['GoalRead']

function progressSentence(p: Schemas['GoalProgress']) {
  if (Number(p.remaining) <= 0) return 'You have reached this goal.'
  if (p.months_left <= 0) return `The target date has passed; ${formatMoney(p.remaining)} is still to go.`
  const months = `${p.months_left} ${p.months_left === 1 ? 'month' : 'months'} left. `
  return `${months}You need ${formatMoney(p.required_monthly)}/month; you've averaged ${formatMoney(p.actual_monthly_average)}.`
}

export function GoalCard({ goal, onEdit }: { goal: Goal; onEdit: () => void }) {
  const { update } = useGoalMutations()
  const [confirmingArchive, setConfirmingArchive] = useState(false)
  const p = goal.progress
  const target = Number(goal.target_amount)
  const percent = p && target > 0 ? Math.min(100, Math.max(0, (Number(p.saved_so_far) / target) * 100)) : 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>{goal.name}</CardTitle>
          {p && (
            <Badge variant={p.on_track ? 'secondary' : 'outline'} className={p.on_track ? undefined : 'border-amber-500/50 text-amber-700 dark:text-amber-400'}>
              {p.on_track ? 'On track' : 'Behind'}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {p ? (
          <div className="space-y-2">
            <Progress value={percent} aria-label={`Progress for ${goal.name}`} />
            <div className="flex flex-wrap justify-between gap-x-4 text-sm">
              <span className="tabular-nums">
                {formatMoney(p.saved_so_far)} of {formatMoney(goal.target_amount)}
              </span>
              <span className="text-muted-foreground">by {formatDate(goal.target_date)}</span>
            </div>
            <p className="text-sm text-muted-foreground">{progressSentence(p)}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {formatMoney(goal.target_amount)} by {formatDate(goal.target_date)}
          </p>
        )}

        <Suggestions goalId={goal.id} />

        <div className="flex items-center gap-1 border-t pt-3">
          <Button size="xs" variant="ghost" className="text-muted-foreground" aria-label={`Edit ${goal.name}`} onClick={onEdit}>
            Edit
          </Button>
          {confirmingArchive ? (
            <>
              <span className="text-xs text-muted-foreground">Archive this goal?</span>
              <Button
                size="xs"
                variant="secondary"
                disabled={update.isPending}
                aria-label={`Confirm archive ${goal.name}`}
                onClick={() => update.mutate({ id: goal.id, body: { is_active: false } })}
              >
                Archive
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setConfirmingArchive(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              aria-label={`Archive ${goal.name}`}
              onClick={() => setConfirmingArchive(true)}
            >
              Archive
            </Button>
          )}
        </div>
        {update.isError && (
          <p role="alert" className="text-sm text-destructive">
            {update.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
