import { useId, type Ref } from 'react'
import type { Schemas } from '@/api/client'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCategories } from '@/features/transactions/queries'
import { RuleMatchSelect, type RuleMatchType } from '@/features/transactions/RuleMatchSelect'
import { CategorySelect, EssentialitySelect } from '@/features/transactions/selects'
import { matchCountText, ruleBody, type RuleDraft } from './draft'
import { useRulePreview } from './queries'

const PLACEHOLDERS: Record<RuleMatchType, string> = {
  exact: 'NETFLIX',
  prefix: 'UBER',
  contains: 'PAYPAL INST XFER',
}

function MatchCount({ matchType, pattern }: { matchType: RuleMatchType; pattern: string }) {
  const preview = useRulePreview(matchType, pattern)
  if (!pattern.trim()) return null
  return (
    <p className="text-xs text-muted-foreground" aria-live="polite">
      {preview.data ? matchCountText(preview.data) : preview.isError ? 'Could not count matches.' : 'Counting matches...'}
    </p>
  )
}

/**
 * A rule's match type, pattern, category, and optional essentiality, with a live count of the
 * transactions it would match. Controlled: the parent owns the draft and the submit button
 * (give it `form={id}`).
 */
export function RuleForm({
  id,
  draft,
  onChange,
  onSubmit,
  patternRef,
}: {
  id: string
  draft: RuleDraft
  onChange: (draft: RuleDraft) => void
  onSubmit: (body: Schemas['RuleCreate']) => void
  patternRef?: Ref<HTMLInputElement>
}) {
  const categories = useCategories()
  const patternId = useId()
  return (
    <form
      id={id}
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        const body = ruleBody(draft)
        if (body) onSubmit(body)
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor={patternId}>When</Label>
        <div className="flex gap-2">
          <RuleMatchSelect
            value={draft.match_type}
            onChange={(match_type) => onChange({ ...draft, match_type })}
            className="shrink-0"
          />
          <Input
            id={patternId}
            ref={patternRef}
            aria-label="Pattern"
            placeholder={PLACEHOLDERS[draft.match_type]}
            maxLength={200}
            value={draft.pattern}
            onChange={(e) => onChange({ ...draft, pattern: e.target.value })}
          />
        </div>
        <MatchCount matchType={draft.match_type} pattern={draft.pattern} />
      </div>
      <div className="grid gap-2">
        <Label>Category</Label>
        <CategorySelect
          categories={categories.data ?? []}
          value={draft.category_id}
          onChange={(category_id) => onChange({ ...draft, category_id })}
          label="Category"
        />
      </div>
      <div className="grid gap-2">
        <Label>
          Essentiality <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <EssentialitySelect
          value={draft.essentiality}
          onChange={(essentiality) => onChange({ ...draft, essentiality })}
          label="Essentiality"
          allowUnset
        />
      </div>
    </form>
  )
}
