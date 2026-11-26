import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { ListFilter, StickyNote } from 'lucide-react'
import type { Schemas } from '@/api/client'
import { useTransactionPanel } from '@/app/transactionPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TableCell, TableRow } from '@/components/ui/table'
import { formatDate } from '@/lib/format'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { useUpdateTransaction } from './queries'
import { needsReview } from './review'
import { NoteEditor } from './NoteEditor'
import { OneTimeToggle } from './OneTimeToggle'
import { RecurringMark } from './RecurringMark'
import { UnpairTransfer } from './UnpairTransfer'
import { CategorySelect, EssentialitySelect } from './selects'

type Txn = Schemas['TransactionRead']

/** Controls inside a row act on their own; a click anywhere else opens the panel. */
const CONTROLS = 'a, button, input, select, textarea, [role="combobox"], [role="option"], [role="listbox"], [role="dialog"]'

/** A click on the row itself, not on a control in it or in a popup it opened (popups are portaled out of the row). */
function isRowClick(e: MouseEvent<HTMLElement>): boolean {
  const target = e.target as HTMLElement
  return e.currentTarget.contains(target) && target.closest(CONTROLS) === null
}

export function TransactionRow({
  txn,
  accountName,
  categories,
  action,
  onKeep,
  leaving = false,
}: {
  txn: Txn
  accountName: string
  categories: Schemas['CategoryRead'][]
  /** Optional trailing cell (e.g. the review queue's "Looks right"). */
  action?: ReactNode
  /** Called with true while the "Make this a rule" offer needs this row to stay on screen. */
  onKeep?: (keep: boolean) => void
  /** Cleared from the list and fading out (styled in index.css); no longer interactive. */
  leaving?: boolean
}) {
  const update = useUpdateTransaction()
  const panel = useTransactionPanel()
  // The category the "Make this a rule" offer would start a rule with; null when hidden.
  const [ruleCategory, setRuleCategory] = useState<number | null>(null)

  const inflow = Number(txn.amount) > 0
  const description = txn.payee ?? txn.raw_description

  function changeCategory(id: number | null) {
    if (id === null || id === txn.categorization?.category_id) return
    // Lists that drop resolved rows must keep this one while the rule offer is shown.
    if (!txn.is_transfer) onKeep?.(true)
    update.mutate(
      { id: txn.id, body: { category_id: id } },
      {
        onSuccess: () => !txn.is_transfer && setRuleCategory(id),
        onError: () => onKeep?.(false),
      },
    )
  }

  function dismissOffer() {
    setRuleCategory(null)
    onKeep?.(false)
  }

  const openPanel = () => panel.open(txn)
  const openRule = (categoryId?: number) =>
    panel.open(txn, { section: 'rule', categoryId, onClose: categoryId === undefined ? undefined : dismissOffer })

  return (
    <TableRow
      className="group/row cursor-pointer"
      tabIndex={0}
      data-row-id={txn.id}
      data-leaving={leaving || undefined}
      aria-hidden={leaving || undefined}
      inert={leaving}
      aria-label={`${description}, ${formatMoney(txn.amount)} on ${formatDate(txn.posted_on)}`}
      onClick={(e) => isRowClick(e) && openPanel()}
      onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) openPanel()
      }}
    >
      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(txn.posted_on)}</TableCell>
      <TableCell className="min-w-48 max-w-80 whitespace-normal">
        <div className="flex items-center gap-2">
          <span className="truncate" title={txn.raw_description}>
            {description}
          </span>
          <NoteEditor txn={txn} label={description} />
          {!txn.is_transfer && (
            <Button
              size="icon-xs"
              variant="ghost"
              className="shrink-0 text-muted-foreground sm:opacity-0 sm:group-hover/row:opacity-100 sm:group-focus-within/row:opacity-100 sm:focus-visible:opacity-100"
              aria-label={`Rule for ${description}`}
              title="Rule"
              onClick={() => openRule()}
            >
              <ListFilter aria-hidden />
            </Button>
          )}
          {!txn.is_transfer && <RecurringMark txn={txn} label={description} />}
          {!txn.is_transfer && !inflow && <OneTimeToggle txn={txn} label={description} />}
          {txn.is_transfer && <UnpairTransfer txn={txn} label={description} />}
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
        {ruleCategory !== null && (
          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => openRule(ruleCategory)}>
              Make this a rule
            </button>
            <button type="button" className="hover:text-foreground" onClick={dismissOffer}>
              Dismiss
            </button>
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
      {action !== undefined && (
        <TableCell className="text-right" data-row-action>
          {action}
        </TableCell>
      )}
    </TableRow>
  )
}
