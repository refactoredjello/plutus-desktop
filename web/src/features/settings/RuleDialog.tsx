import { useId, useState } from 'react'
import type { Schemas } from '@/api/client'
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
import { useSaveRule } from '@/features/rules/queries'
import { ruleBody, ruleDraft, type RuleDraft } from '@/features/rules/draft'
import { RuleForm } from '@/features/rules/RuleForm'

type Rule = Schemas['RuleRead']

const EMPTY: RuleDraft = { match_type: 'exact', pattern: '', category_id: null, essentiality: null }

/**
 * A rule's match type, pattern, category, and optional essentiality. Without `rule` it is the
 * "New rule" button and creates one; with `rule` it is that row's "Edit" button, prefilled.
 */
export function RuleDialog({ rule }: { rule?: Rule }) {
  const save = useSaveRule(rule)
  const formId = useId()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<RuleDraft>(EMPTY)

  function onOpenChange(next: boolean) {
    if (next) {
      setDraft(rule ? ruleDraft(rule) : EMPTY)
      save.reset()
    }
    setOpen(next)
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
        <RuleForm id={formId} draft={draft} onChange={setDraft} onSubmit={(body) => save.mutate(body, { onSuccess: () => setOpen(false) })} />
        {save.isError && (
          <p role="alert" className="text-sm text-destructive">
            {save.error.message}
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button type="submit" form={formId} disabled={!ruleBody(draft) || save.isPending}>
            {rule ? 'Save' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
