import { useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link } from 'react-router'
import type { Schemas } from '@/api/client'
import type { PanelOptions } from '@/app/transactionPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { useSaveRule, useTransactionRule } from '@/features/rules/queries'
import { ruleBody, ruleDraft, type RuleDraft } from '@/features/rules/draft'
import { RuleForm } from '@/features/rules/RuleForm'
import { useAccounts } from '@/features/settings/queries'
import { formatDate } from '@/lib/format'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { transactionsLink } from './filters'
import { patchTransaction, useCategories, useUpdateTransaction, type TransactionEdit } from './queries'
import type { RuleMatchType } from './RuleMatchSelect'
import { CategorySelect, EssentialitySelect } from './selects'

type Txn = Schemas['TransactionRead']

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  )
}

/**
 * The one side panel for a transaction, on every page: its full details, category and
 * essentiality, and the rule that matches it (edited here) or a new one.
 */
export function TransactionPanel({
  txn: initial,
  options,
  open,
  onOpenChange,
}: {
  txn: Txn
  options: PanelOptions
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // The panel's own copy, so edits made here show at once on whichever page opened it.
  const [txn, setTxn] = useState(initial)
  const update = useUpdateTransaction()
  const accounts = useAccounts()
  const categories = useCategories()
  const ruleRef = useRef<HTMLElement>(null)
  const name = txn.payee ?? txn.raw_description
  const inflow = Number(txn.amount) > 0

  function edit(body: TransactionEdit) {
    const before = txn
    setTxn(patchTransaction(txn, body))
    update.mutate({ id: txn.id, body }, { onSuccess: setTxn, onError: () => setTxn(before) })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-md" initialFocus={options.section === 'rule' ? ruleRef : undefined}>
        <SheetHeader className="pr-12">
          <SheetTitle className="break-words">{name}</SheetTitle>
          <SheetDescription>
            <span className={cn('font-medium tabular-nums', inflow ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground')}>
              {inflow && '+'}
              {formatMoney(txn.amount)}
            </span>{' '}
            on {formatDate(txn.posted_on)}
          </SheetDescription>
        </SheetHeader>

        <section aria-label="Details" className="grid gap-4 px-4">
          {(txn.pending || txn.one_time || txn.is_transfer) && (
            <div className="flex flex-wrap gap-1">
              {txn.pending && <Badge variant="secondary">Pending</Badge>}
              {txn.one_time && <Badge variant="secondary">One-time</Badge>}
              {txn.is_transfer && <Badge variant="secondary">Transfer</Badge>}
            </div>
          )}
          <dl className="grid gap-2 text-sm">
            {txn.payee && <Detail label="Payee">{txn.payee}</Detail>}
            <Detail label="Bank description">{txn.raw_description}</Detail>
            {txn.memo && <Detail label="Memo">{txn.memo}</Detail>}
            <Detail label="Account">{accounts.data?.find((a) => a.id === txn.account_id)?.name ?? '-'}</Detail>
            <Detail label="Date">{formatDate(txn.posted_on)}</Detail>
            {txn.note && <Detail label="Note">{txn.note}</Detail>}
          </dl>
          <div className="grid grid-cols-2 gap-2">
            <CategorySelect
              categories={categories.data ?? []}
              value={txn.categorization?.category_id}
              onChange={(id) => id !== null && id !== txn.categorization?.category_id && edit({ category_id: id })}
              label={`Category for ${name}`}
            />
            <EssentialitySelect
              value={txn.categorization?.essentiality}
              onChange={(essentiality) => essentiality && edit({ essentiality })}
              label={`Essentiality for ${name}`}
            />
          </div>
          {update.isError && (
            <p role="alert" className="text-xs text-destructive">
              Could not save: {update.error.message}
            </p>
          )}
          <Link
            to={transactionsLink(txn)}
            onClick={() => onOpenChange(false)}
            className="text-sm underline underline-offset-2 hover:text-foreground"
          >
            View in Transactions
          </Link>
        </section>

        <Separator />

        <RuleSection txn={txn} categoryId={options.categoryId} sectionRef={ruleRef} />
      </SheetContent>
    </Sheet>
  )
}

function RuleSection({
  txn,
  categoryId,
  sectionRef,
}: {
  txn: Txn
  categoryId: number | undefined
  sectionRef: RefObject<HTMLElement | null>
}) {
  const lookup = useTransactionRule(txn.id, !txn.is_transfer)
  const [saved, setSaved] = useState(false)
  const data = lookup.data
  return (
    <section ref={sectionRef} tabIndex={-1} aria-label="Rule" className="grid gap-3 px-4 pb-4 outline-none">
      <h3 className="font-heading text-sm font-medium">Rule</h3>
      {txn.is_transfer ? (
        <p className="text-sm text-muted-foreground">Rules never categorize transfers.</p>
      ) : lookup.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load the rule: {lookup.error.message}
        </p>
      ) : !data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <RuleEditor
          // A new rule turns into an edit once saved: start over from the saved rule.
          key={data.rule?.id ?? 'new'}
          lookup={data}
          categoryId={categoryId}
          onSaved={() => setSaved(true)}
          onChange={() => setSaved(false)}
        />
      )}
      {saved && <p className="text-xs text-muted-foreground">Rule saved.</p>}
    </section>
  )
}

/** Edits the matching rule (PATCH), or creates one from the suggestion (POST). */
function RuleEditor({
  lookup,
  categoryId,
  onSaved,
  onChange,
}: {
  lookup: Schemas['TransactionRuleRead']
  categoryId: number | undefined
  onSaved: () => void
  onChange: () => void
}) {
  const { rule, suggestion } = lookup
  const save = useSaveRule(rule)
  const formId = useId()
  const defaultPattern = (t: RuleMatchType) => (t === 'contains' ? suggestion.contains_pattern : suggestion.pattern)
  const [draft, setDraft] = useState<RuleDraft>(() => {
    const base: RuleDraft = rule
      ? ruleDraft(rule)
      : { match_type: suggestion.match_type, pattern: suggestion.pattern, category_id: suggestion.category_id, essentiality: suggestion.essentiality }
    return categoryId === undefined ? base : { ...base, category_id: categoryId }
  })

  function change(next: RuleDraft) {
    // A new rule's pattern follows the match type's default until the owner edits it.
    const follows = !rule && next.match_type !== draft.match_type && draft.pattern === defaultPattern(draft.match_type)
    setDraft(follows ? { ...next, pattern: defaultPattern(next.match_type) } : next)
    onChange()
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        {rule ? 'This rule categorizes this transaction.' : 'No rule matches this transaction yet.'}
      </p>
      <RuleForm id={formId} draft={draft} onChange={change} onSubmit={(body) => save.mutate(body, { onSuccess: onSaved })} />
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          {save.error.message}
        </p>
      )}
      <div>
        <Button type="submit" form={formId} size="sm" disabled={!ruleBody(draft) || save.isPending}>
          {rule ? 'Save rule' : 'Create rule'}
        </Button>
      </div>
    </div>
  )
}
