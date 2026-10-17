import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useAccounts } from '@/features/settings/queries'
import { emptyFilters, hasActiveFilters, type Filters } from './filters'
import { useCategories } from './queries'
import { CategorySelect, EssentialityFilterSelect } from './selects'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const ALL = 'all'

export function FilterBar({
  filters,
  onChange,
}: {
  filters: Filters
  onChange: (patch: Partial<Filters>) => void
}) {
  const accounts = useAccounts()
  const categories = useCategories()

  // Search is debounced into the URL; `draft` keeps the input responsive meanwhile.
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => {
    if (draft === null) return
    const timer = setTimeout(() => {
      onChange({ q: draft })
      setDraft(null)
    }, 300)
    return () => clearTimeout(timer)
  }, [draft, onChange])

  const accountItems = {
    [ALL]: 'All accounts',
    ...Object.fromEntries((accounts.data ?? []).map((a) => [String(a.id), a.name])),
  }

  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label="Search transactions"
          placeholder="Search descriptions and notes"
          className="w-full sm:w-72"
          value={draft ?? filters.q}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Input
          type="date"
          aria-label="From date"
          className="w-auto"
          value={filters.start}
          onChange={(e) => onChange({ start: e.target.value })}
        />
        <Input
          type="date"
          aria-label="To date"
          className="w-auto"
          value={filters.end}
          onChange={(e) => onChange({ end: e.target.value })}
        />
        <Select
          items={accountItems}
          value={filters.account || ALL}
          onValueChange={(v) => onChange({ account: !v || v === ALL ? '' : v })}
        >
          <SelectTrigger aria-label="Account filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectItem value={ALL}>All accounts</SelectItem>
            {(accounts.data ?? []).map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <CategorySelect
          categories={categories.data ?? []}
          value={filters.category}
          onChange={(id) => onChange({ category: id === null ? '' : String(id), uncategorized: false })}
          uncategorized={filters.uncategorized}
          onUncategorized={() => onChange({ category: '', uncategorized: true })}
          label="Category filter"
          allLabel="All categories"
        />
        <EssentialityFilterSelect
          value={filters.essentiality}
          onChange={(v) => onChange({ essentiality: v ?? '' })}
          label="Essentiality filter"
          allLabel="Any essentiality"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <Switch
            size="sm"
            checked={filters.review}
            onCheckedChange={(review) => onChange({ review })}
          />
          Needs review
        </label>
        <label className="flex items-center gap-2">
          <Switch
            size="sm"
            checked={filters.transfers}
            onCheckedChange={(transfers) => onChange({ transfers })}
          />
          Include transfers
        </label>
        {hasActiveFilters(filters) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              onChange({ ...emptyFilters, page: 1 })
            }
          >
            Clear filters
          </Button>
        )}
      </div>
    </div>
  )
}
