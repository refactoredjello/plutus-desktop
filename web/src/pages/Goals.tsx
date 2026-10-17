import { useState } from 'react'
import { PlusIcon } from 'lucide-react'
import type { Schemas } from '@/api/client'
import { PageHeader } from '@/app/PageHeader'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { GoalCard } from '@/features/goals/GoalCard'
import { GoalDialog } from '@/features/goals/GoalDialog'
import { useGoals } from '@/features/goals/queries'

export function GoalsPage() {
  const goals = useGoals()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Schemas['GoalRead'] | null>(null)
  const active = goals.data?.filter((g) => g.is_active) ?? []

  return (
    <div>
      <PageHeader
        title="Goals"
        description="Savings goals and suggestions."
        action={
          <Button onClick={() => setCreating(true)}>
            <PlusIcon /> New goal
          </Button>
        }
      />
      {goals.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : goals.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {goals.error.message}
        </p>
      ) : active.length === 0 ? (
        <p className="text-sm text-muted-foreground">No goals yet. Set one to see what it takes to get there.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {active.map((g) => (
            <GoalCard key={g.id} goal={g} onEdit={() => setEditing(g)} />
          ))}
        </div>
      )}
      <GoalDialog open={creating} goal={null} onClose={() => setCreating(false)} />
      <GoalDialog open={editing !== null} goal={editing} onClose={() => setEditing(null)} />
    </div>
  )
}
