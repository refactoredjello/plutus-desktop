import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCategories } from '@/features/transactions/queries'
import { RuleMatchSelect, type RuleMatchType } from '@/features/transactions/RuleMatchSelect'
import { CategorySelect, EssentialitySelect } from '@/features/transactions/selects'

const PLACEHOLDERS: Record<RuleMatchType, string> = {
  exact: 'NETFLIX',
  prefix: 'UBER',
  contains: 'PAYPAL INST XFER',
}

/** A new rule changes categorizations, so transactions refresh with the rule list. */
function useCreateRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['RuleCreate']) => unwrap(api.POST('/api/rules', { body })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rules'] })
      void qc.invalidateQueries({ queryKey: ['transactions'] })
    },
  })
}

/** "New rule" button and dialog: a match type, a pattern, a category, and optionally an essentiality. */
export function NewRuleDialog() {
  const categories = useCategories()
  const create = useCreateRule()
  const [open, setOpen] = useState(false)
  const [matchType, setMatchType] = useState<RuleMatchType>('exact')
  const [pattern, setPattern] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [essentiality, setEssentiality] = useState<Schemas['Essentiality'] | null>(null)

  function onOpenChange(next: boolean) {
    if (next) {
      setMatchType('exact')
      setPattern('')
      setCategoryId(null)
      setEssentiality(null)
      create.reset()
    }
    setOpen(next)
  }

  const text = pattern.trim()
  function submit() {
    if (!text || categoryId === null) return
    const body: Schemas['RuleCreate'] = { match_type: matchType, pattern: text, category_id: categoryId }
    if (essentiality) body.essentiality = essentiality
    create.mutate(body, { onSuccess: () => setOpen(false) })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>New rule</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New rule</DialogTitle>
          <DialogDescription>Categorize matching transactions now and as they arrive.</DialogDescription>
        </DialogHeader>
        <form
          id="new-rule"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="new-rule-pattern">When</Label>
            <div className="flex gap-2">
              <RuleMatchSelect value={matchType} onChange={setMatchType} className="shrink-0" />
              <Input
                id="new-rule-pattern"
                aria-label="Pattern"
                placeholder={PLACEHOLDERS[matchType]}
                maxLength={200}
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Category</Label>
            <CategorySelect categories={categories.data ?? []} value={categoryId} onChange={setCategoryId} label="Category" />
          </div>
          <div className="grid gap-2">
            <Label>
              Essentiality <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <EssentialitySelect value={essentiality} onChange={setEssentiality} label="Essentiality" allowUnset />
          </div>
        </form>
        {create.isError && (
          <p role="alert" className="text-sm text-destructive">
            {create.error.message}
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button type="submit" form="new-rule" disabled={!text || categoryId === null || create.isPending}>
            Create rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
