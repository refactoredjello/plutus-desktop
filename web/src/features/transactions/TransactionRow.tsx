import { useState, type ReactNode } from 'react'
import { StickyNote } from 'lucide-react'
import type { Schemas } from '@/api/client'
import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { TableCell, TableRow } from '@/components/ui/table'
import { cadencePhrase } from '@/features/recurring/queries'
import { formatDate } from '@/lib/format'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { ApplyToAllPrompt } from './ApplyToAllPrompt'
import { useUpdateTransaction } from './queries'
import { needsReview } from './review'
import { NoteEditor } from './NoteEditor'
import { OneTimeToggle } from './OneTimeToggle'
import { RecurringMark } from './RecurringMark'
import type { RuleMatchType } from './RuleMatchSelect'
import { CategorySelect, EssentialitySelect } from './selects'

type Txn = Schemas['TransactionRead']

export function TransactionRow({
  txn,
  accountName,
  categories,
  action,
  onKeep,
}: {
  txn: Txn
  accountName: string
  categories: Schemas['CategoryRead'][]
  /** Optional trailing cell (e.g. the review queue's "Looks right"). */
  action?: ReactNode
  /** Called with true while the apply-to-all prompt needs this row to stay on screen. */
  onKeep?: (keep: boolean) => void
}) {
  const update = useUpdateTransaction()
  // Category id the "apply to all" prompt would save as a rule; null when hidden or dismissed.
  const [promptCategory, setPromptCategory] = useState<number | null>(null)
  const [ruleSaved, setRuleSaved] = useState(false)
  const [markedCadence, setMarkedCadence] = useState<Schemas['Cadence'] | null>(null)

  const inflow = Number(txn.amount) > 0
  const description = txn.payee ?? txn.raw_description

  function changeCategory(id: number | null) {
    if (id === null || id === txn.categorization?.category_id) return
    setRuleSaved(false)
    // Lists that drop resolved rows must keep this one until the apply-to-all prompt is answered.
    if (txn.merchant_key) onKeep?.(true)
    update.mutate(
      { id: txn.id, body: { category_id: id } },
      {
        onSuccess: () => txn.merchant_key && setPromptCategory(id),
        onError: () => onKeep?.(false),
      },
    )
  }

  function dismissPrompt() {
    setPromptCategory(null)
    onKeep?.(false)
  }

  function applyToAll(matchType: RuleMatchType, pattern: string) {
    if (promptCategory === null) return
    update.mutate(
      {
        id: txn.id,
        body: { category_id: promptCategory, save_as_rule: true, rule_match_type: matchType, rule_pattern: pattern },
      },
      {
        onSuccess: () => {
          setPromptCategory(null)
          setRuleSaved(true)
          onKeep?.(false)
        },
      },
    )
  }

  return (
    <TableRow className="group/row">
      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(txn.posted_on)}</TableCell>
      <TableCell className="min-w-48 max-w-80 whitespace-normal">
        <div className="flex items-center gap-2">
          <span className="truncate" title={txn.raw_description}>
            {description}
          </span>
          <NoteEditor txn={txn} label={description} />
          {!txn.is_transfer && <RecurringMark txn={txn} label={description} onMarked={setMarkedCadence} />}
          {!txn.is_transfer && !inflow && <OneTimeToggle txn={txn} label={description} />}
          {txn.one_time && (
            <Badge variant="secondary" className="text-muted-foreground">
              One-time
            </Badge>
          )}
          {txn.pending && (
            <Badge variant="secondary" className="text-muted-foreground">
              Pending
            </Badge>
          )}
        </div>
        {txn.note && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground" title={txn.note}>
            <StickyNote aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{txn.note}</span>
          </p>
        )}
        {promptCategory !== null && (
          <ApplyToAllPrompt txn={txn} pending={update.isPending} onApply={applyToAll} onDismiss={dismissPrompt} />
        )}
        {markedCadence && (
          <p className="mt-1 text-xs text-muted-foreground">
            Recurring {cadencePhrase(markedCadence)}.{' '}
            <Link to="/recurring" className="underline underline-offset-2 hover:text-foreground">
              View
            </Link>
          </p>
        )}
        {ruleSaved && <p className="mt-1 text-xs text-muted-foreground">Rule saved.</p>}
        {update.isError && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            Could not save: {update.error.message}
          </p>
        )}
      </TableCell>
      <TableCell
        className={cn(
          'whitespace-nowrap text-right tabular-nums',
          inflow && 'text-emerald-700 dark:text-emerald-400',
        )}
      >
        {inflow && '+'}
        {formatMoney(txn.amount)}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <CategorySelect
            inline
            categories={categories}
            value={txn.categorization?.category_id}
            onChange={changeCategory}
            label={`Category for ${description}`}
          />
          {needsReview(txn) && (
            <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400">
              Review
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell>
        <EssentialitySelect
          inline
          value={txn.categorization?.essentiality}
          onChange={(essentiality) => essentiality && update.mutate({ id: txn.id, body: { essentiality } })}
          label={`Essentiality for ${description}`}
        />
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-muted-foreground xl:table-cell">{accountName}</TableCell>
      {action !== undefined && <TableCell className="text-right">{action}</TableCell>}
    </TableRow>
  )
}
