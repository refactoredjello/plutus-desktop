import { useState } from 'react'
import { PageHeader } from '@/app/PageHeader'
import { Button } from '@/components/ui/button'
import { LooksRightButton } from '@/features/review/LooksRightButton'
import { reviewFilters, useReviewCount } from '@/features/review/queries'
import { TransactionsTable } from '@/features/transactions/TransactionsTable'
import { needsReview } from '@/features/transactions/review'

type Chip = 'all' | 'none' | 'low'

const chips: { id: Chip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'none', label: 'No category' },
  { id: 'low', label: 'Low confidence' },
]

export function ReviewPage() {
  const [chip, setChip] = useState<Chip>('all')
  const [page, setPage] = useState(1)
  const { count, isSuccess } = useReviewCount()

  const filters = { ...reviewFilters, uncategorized: chip === 'none', page }
  return (
    <div>
      <PageHeader
        title="Review"
        description={isSuccess ? (count === 0 ? 'Nothing needs a second look.' : `${count} to review`) : 'Transactions that need a category or a second look.'}
      />
      <div role="group" aria-label="Show" className="mb-4 flex gap-1">
        {chips.map((c) => (
          <Button
            key={c.id}
            size="sm"
            variant={chip === c.id ? 'secondary' : 'ghost'}
            aria-pressed={chip === c.id}
            onClick={() => {
              setChip(c.id)
              setPage(1)
            }}
          >
            {c.label}
          </Button>
        ))}
      </div>
      <TransactionsTable
        filters={filters}
        onChange={(patch) => patch.page && setPage(patch.page)}
        // Resolved rows leave straight away: the optimistic edit marks them manual, which no longer needs review.
        // "Low confidence" is the rest of the queue: the API has no filter for it, so it is applied to each page here.
        visible={(t) => needsReview(t) && (chip !== 'low' || t.categorization !== null)}
        action={{
          header: '',
          render: (t) =>
            t.categorization ? <LooksRightButton id={t.id} categoryId={t.categorization.category_id} /> : null,
        }}
        empty="All caught up."
      />
    </div>
  )
}
