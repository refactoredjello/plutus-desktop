import type { Schemas } from '@/api/client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export type RuleMatchType = Schemas['RuleMatchType']

/** How each match type reads to the owner: exact and prefix match the merchant, contains the bank's description. */
const MATCH_TYPE_LABELS: Record<RuleMatchType, string> = {
  exact: 'Merchant is',
  prefix: 'Merchant starts with',
  contains: 'Bank description contains',
}

const MATCH_TYPES = Object.keys(MATCH_TYPE_LABELS) as RuleMatchType[]

export function RuleMatchSelect({
  value,
  onChange,
  className,
}: {
  value: RuleMatchType
  onChange: (value: RuleMatchType) => void
  className?: string
}) {
  return (
    <Select items={MATCH_TYPE_LABELS} value={value} onValueChange={(v) => v && onChange(v as RuleMatchType)}>
      <SelectTrigger size="sm" aria-label="Match type" className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {MATCH_TYPES.map((t) => (
          <SelectItem key={t} value={t}>
            {MATCH_TYPE_LABELS[t]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
