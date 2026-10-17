import { useState } from 'react'
import { PlusIcon } from 'lucide-react'
import type { Schemas } from '@/api/client'
import { PageHeader } from '@/app/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EntryDialog } from '@/features/planned/EntryDialog'
import { usePlanned, usePlannedMutations } from '@/features/planned/queries'
import { useCategories } from '@/features/transactions/queries'
import { formatDate, humanizeEnum } from '@/lib/format'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'

type Entry = Schemas['ManualEntryRead']

export function ManualEntriesPage() {
  const planned = usePlanned()
  const categories = useCategories()
  const { remove } = usePlannedMutations()
  const [editing, setEditing] = useState<Entry | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<Entry | null>(null)
  const categoryLabel = new Map((categories.data ?? []).map((c) => [c.id, c.label]))

  return (
    <div>
      <PageHeader
        title="Planned"
        description="Expected income and expenses not yet in your accounts."
        action={
          <Button onClick={() => setAdding(true)}>
            <PlusIcon /> Add planned item
          </Button>
        }
      />
      {planned.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : planned.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {planned.error.message}
        </p>
      ) : planned.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing planned. Add a bill or paycheck you expect so it shows up in your forecast.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Repeats</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {planned.data.map((e) => {
              const inflow = Number(e.amount) > 0
              const fulfilled = e.fulfilled_transaction_id !== null
              return (
                <TableRow key={e.id}>
                  <TableCell className="max-w-56 truncate font-medium" title={e.description}>
                    {e.description}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'whitespace-nowrap text-right tabular-nums',
                      inflow && 'text-emerald-700 dark:text-emerald-400',
                    )}
                  >
                    {inflow && '+'}
                    {formatMoney(e.amount)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(e.due_date)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {e.recurrence === 'none' ? '—' : humanizeEnum(e.recurrence)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {(e.category_id !== null && categoryLabel.get(e.category_id)) || '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={fulfilled ? 'secondary' : 'outline'} className="text-muted-foreground">
                      {fulfilled ? 'Fulfilled' : 'Open'}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <Button size="xs" variant="ghost" aria-label={`Edit ${e.description}`} onClick={() => setEditing(e)}>
                      Edit
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-muted-foreground"
                      aria-label={`Delete ${e.description}`}
                      onClick={() => setDeleting(e)}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

      <EntryDialog open={adding} entry={null} onClose={() => setAdding(false)} />
      <EntryDialog open={editing !== null} entry={editing} onClose={() => setEditing(null)} />

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete planned item?</DialogTitle>
            <DialogDescription>
              {deleting ? `"${deleting.description}" will be removed. This cannot be undone.` : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
