import { useState } from 'react'
import type { Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { containsPattern } from './casefold'
import { RuleMatchSelect, type RuleMatchType } from './RuleMatchSelect'

/**
 * The pattern a rule starts from: the merchant key; for contains, the payee when the bank
 * description contains it, else the description, so the rule matches this transaction.
 */
function defaultPattern(txn: Schemas['TransactionRead'], matchType: RuleMatchType): string {
  if (matchType !== 'contains') return txn.merchant_key ?? ''
  const payee = txn.payee?.trim()
  return payee && containsPattern(txn.raw_description, payee) ? payee : txn.raw_description
}

/** After a category change: offer a rule for transactions like this one, with an editable match. */
export function ApplyToAllPrompt({
  txn,
  pending,
  onApply,
  onDismiss,
}: {
  txn: Schemas['TransactionRead']
  pending: boolean
  onApply: (matchType: RuleMatchType, pattern: string) => void
  onDismiss: () => void
}) {
  const [matchType, setMatchType] = useState<RuleMatchType>('exact')
  const [pattern, setPattern] = useState(() => defaultPattern(txn, 'exact'))
  // Until the owner edits the pattern, it follows the match type's default.
  const [edited, setEdited] = useState(false)

  function changeType(next: RuleMatchType) {
    setMatchType(next)
    if (!edited) setPattern(defaultPattern(txn, next))
  }

  const text = pattern.trim()
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <span>Apply to all where</span>
      <RuleMatchSelect value={matchType} onChange={changeType} />
      <Input
        aria-label="Pattern"
        className="h-7 w-44 text-xs"
        value={pattern}
        maxLength={200}
        onChange={(e) => {
          setPattern(e.target.value)
          setEdited(true)
        }}
      />
      <Button size="xs" variant="secondary" disabled={pending || !text} onClick={() => onApply(matchType, text)}>
        Apply
      </Button>
      <Button size="xs" variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  )
}
