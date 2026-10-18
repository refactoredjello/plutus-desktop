import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useCategories } from '@/features/transactions/queries'
import { humanizeEnum } from '@/lib/format'
import { RuleDialog } from './RuleDialog'

type Rule = Schemas['RuleRead']

const MATCH_WORDS: Record<Rule['match_type'], string> = {
  exact: 'is',
  prefix: 'starts with',
  contains: 'description contains',
}

function useRules() {
  return useQuery({ queryKey: ['rules'], queryFn: () => unwrap(api.GET('/api/rules')) })
}

function useDeleteRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => unwrap(api.DELETE('/api/rules/{rule_id}', { params: { path: { rule_id: id } } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rules'] })
      void qc.invalidateQueries({ queryKey: ['transactions'] })
    },
  })
}

export function RulesCard() {
  const rules = useRules()
  const categories = useCategories()
  const remove = useDeleteRule()
  const [deleting, setDeleting] = useState<Rule | null>(null)
  const label = new Map((categories.data ?? []).map((c) => [c.id, c.label]))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rules</CardTitle>
        <CardDescription>Merchants that are categorized automatically.</CardDescription>
        <CardAction>
          <RuleDialog />
        </CardAction>
      </CardHeader>
      <CardContent>
        {rules.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : !rules.data?.length ? (
          <p className="text-sm text-muted-foreground">
            No rules yet. Add one with "New rule", or change a transaction's category on the Transactions page and choose
            "Apply to all".
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Merchant</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Essentiality</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="max-w-56 truncate font-medium" title={r.pattern}>
                    <span className="mr-1 text-xs font-normal text-muted-foreground">{MATCH_WORDS[r.match_type]}</span>
                    {r.pattern}
                  </TableCell>
                  <TableCell>{label.get(r.category_id) ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{r.essentiality ? humanizeEnum(r.essentiality) : '—'}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <RuleDialog rule={r} />
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-muted-foreground"
                      aria-label={`Delete rule for ${r.pattern}`}
                      onClick={() => setDeleting(r)}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {remove.isError && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {remove.error.message}
          </p>
        )}
      </CardContent>

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete rule?</DialogTitle>
            <DialogDescription>
              {deleting ? `Future transactions from ${deleting.pattern} will no longer be categorized automatically.` : ''}
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
    </Card>
  )
}
