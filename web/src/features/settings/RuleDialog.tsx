import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { invalidateDerived } from '@/app/invalidate'
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

type Rule = Schemas['RuleRead']

const PLACEHOLDERS: Record<RuleMatchType, string> = {
  exact: 'NETFLIX',
  prefix: 'UBER',
  contains: 'PAYPAL INST XFER',
}

/**
 * Creates a rule, or saves an edit to `rule` (sent whole; a null essentiality clears it).
 * Either changes categorizations, so transactions refresh with the rule list.
 */
function useSaveRule(rule: Rule | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['RuleCreate']) =>
      rule
        ? unwrap(
            api.PATCH('/api/rules/{rule_id}', {
              params: { path: { rule_id: rule.id } },
              body: { ...body, essentiality: body.essentiality ?? null },
            }),
          )
        : unwrap(api.POST('/api/rules', { body })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rules'] })
      void invalidateDerived(qc)
    },
  })
}

/**
 * A rule's match type, pattern, category, and optional essentiality. Without `rule` it is the
 * "New rule" button and creates one; with `rule` it is that row's "Edit" button, prefilled.
 */
export function RuleDialog({ rule }: { rule?: Rule }) {
  const categories = useCategories()
  const save = useSaveRule(rule)
  const formId = useId()
  const patternId = useId()
  const [open, setOpen] = useState(false)
  const [matchType, setMatchType] = useState<RuleMatchType>('exact')
  const [pattern, setPattern] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [essentiality, setEssentiality] = useState<Schemas['Essentiality'] | null>(null)

  function onOpenChange(next: boolean) {
    if (next) {
      setMatchType(rule?.match_type ?? 'exact')
      setPattern(rule?.pattern ?? '')
      setCategoryId(rule?.category_id ?? null)
      setEssentiality(rule?.essentiality ?? null)
      save.reset()
    }
    setOpen(next)
  }

  const text = pattern.trim()
  function submit() {
    if (!text || categoryId === null) return
    const body: Schemas['RuleCreate'] = { match_type: matchType, pattern: text, category_id: categoryId }
    if (essentiality) body.essentiality = essentiality
    save.mutate(body, { onSuccess: () => setOpen(false) })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {rule ? (
        <DialogTrigger
          render={<Button size="xs" variant="ghost" className="text-muted-foreground" aria-label={`Edit rule for ${rule.pattern}`} />}
        >
          Edit
        </DialogTrigger>
      ) : (
        <DialogTrigger render={<Button size="sm" variant="outline" />}>New rule</DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit rule' : 'New rule'}</DialogTitle>
          <DialogDescription>Categorize matching transactions now and as they arrive.</DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor={patternId}>When</Label>
            <div className="flex gap-2">
              <RuleMatchSelect value={matchType} onChange={setMatchType} className="shrink-0" />
              <Input
                id={patternId}
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
        {save.isError && (
          <p role="alert" className="text-sm text-destructive">
            {save.error.message}
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button type="submit" form={formId} disabled={!text || categoryId === null || save.isPending}>
            {rule ? 'Save' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
