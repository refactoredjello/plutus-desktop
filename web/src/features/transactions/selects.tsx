import type { ReactNode } from 'react'
import type { Schemas } from '@/api/client'
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from '@/components/ui/combobox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { humanizeEnum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ESSENTIALITIES } from './review'

type Category = Schemas['CategoryRead']
type Essentiality = Schemas['Essentiality']

const ALL = 'all'
const NONE = 'none'

/** Quiet trigger for in-table editing: looks like text until hovered. */
const inlineTrigger = 'w-full max-w-44 border-transparent bg-transparent hover:border-input'

type CategoryItem = { value: string; label: string; group: string }
type CategoryGroup = { value: string; label: string | null; items: CategoryItem[] }

function categoryGroups(
  categories: Category[],
  currentId: number | null,
  specials: CategoryItem[],
): CategoryGroup[] {
  const groups = new Map<string, CategoryItem[]>()
  for (const c of categories) {
    if (c.is_hidden && c.id !== currentId) continue
    const group = humanizeEnum(c.primary)
    groups.set(c.primary, [...(groups.get(c.primary) ?? []), { value: String(c.id), label: c.label, group }])
  }
  return [
    ...(specials.length ? [{ value: '', label: null, items: specials }] : []),
    ...[...groups].map(([primary, items]) => ({ value: primary, label: humanizeEnum(primary), items })),
  ]
}

/** Case-insensitive match on the category label or its group name. */
function matchesCategory(item: CategoryItem, query: string) {
  const q = query.trim().toLowerCase()
  return item.label.toLowerCase().includes(q) || item.group.toLowerCase().includes(q)
}

/** Searchable category picker (also used as the filter when `allLabel` is given). */
export function CategorySelect({
  categories,
  value,
  onChange,
  label,
  allLabel,
  inline = false,
  uncategorized = false,
  onUncategorized,
}: {
  categories: Category[]
  value: number | string | null | undefined
  onChange: (id: number | null) => void
  label: string
  allLabel?: string
  inline?: boolean
  /** Filter mode only: offer a "No category" option (selected while `uncategorized`). */
  uncategorized?: boolean
  onUncategorized?: () => void
}) {
  const currentId = typeof value === 'number' ? value : Number(value) || null
  const specials: CategoryItem[] = [
    ...(allLabel ? [{ value: ALL, label: allLabel, group: '' }] : []),
    ...(onUncategorized ? [{ value: NONE, label: 'No category', group: '' }] : []),
  ]
  const groups = categoryGroups(categories, currentId, specials)
  const all = groups.flatMap((g) => g.items)
  const selectedValue = uncategorized && onUncategorized
    ? NONE
    : value == null || value === '' ? (allLabel ? ALL : null) : String(value)
  const selected = all.find((i) => i.value === selectedValue) ?? null
  return (
    <Combobox
      items={groups}
      value={selected}
      filter={matchesCategory}
      isItemEqualToValue={(a, b) => a.value === b.value}
      itemToStringLabel={(i) => i.label}
      onValueChange={(item) => {
        if (!item) return
        if (item.value === NONE) onUncategorized?.()
        else onChange(item.value === ALL ? null : Number(item.value))
      }}
    >
      <ComboboxTrigger
        aria-label={label}
        className={cn(
          'flex h-7 w-fit items-center justify-between gap-1.5 rounded-[min(var(--radius-md),10px)] border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50',
          inline && inlineTrigger,
        )}
      >
        <span className="line-clamp-1 flex-1 text-left">
          <ComboboxValue>{(item: CategoryItem | null) => item?.label ?? 'Uncategorized'}</ComboboxValue>
        </span>
      </ComboboxTrigger>
      <ComboboxContent align="start" className="min-w-64">
        <ComboboxInput showTrigger={false} placeholder="Search categories" aria-label="Search categories" />
        <ComboboxEmpty>No matching categories</ComboboxEmpty>
        <ComboboxList>
          {(group: CategoryGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              {group.label && <ComboboxLabel>{group.label}</ComboboxLabel>}
              <ComboboxCollection>
                {(item: CategoryItem) => (
                  <ComboboxItem key={item.value} value={item}>
                    {item.label}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

function EssentialityOptions({
  value,
  onChange,
  label,
  allLabel,
  inline = false,
  includeUnset,
}: {
  includeUnset: boolean
  value: Essentiality | 'unset' | '' | null | undefined
  onChange: (value: Schemas['EssentialityFilter'] | null) => void
  label: string
  allLabel?: string
  inline?: boolean
}): ReactNode {
  const items = {
    ...(allLabel ? { [ALL]: allLabel } : {}),
    ...Object.fromEntries(ESSENTIALITIES.map((e) => [e, humanizeEnum(e)])),
    ...(includeUnset ? { unset: 'Not set' } : {}),
  }
  return (
    <Select
      items={items}
      value={value || (allLabel ? ALL : null)}
      onValueChange={(v) => onChange(v === null || v === ALL ? null : (v as Schemas['EssentialityFilter']))}
    >
      <SelectTrigger size="sm" aria-label={label} className={cn(inline && inlineTrigger)}>
        <SelectValue placeholder="—" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {allLabel && <SelectItem value={ALL}>{allLabel}</SelectItem>}
        {ESSENTIALITIES.map((e) => (
          <SelectItem key={e} value={e}>
            {humanizeEnum(e)}
          </SelectItem>
        ))}
        {includeUnset && <SelectItem value="unset">Not set</SelectItem>}
      </SelectContent>
    </Select>
  )
}

export function EssentialitySelect({
  onChange,
  ...props
}: {
  value: Essentiality | '' | null | undefined
  onChange: (value: Essentiality | null) => void
  label: string
  allLabel?: string
  inline?: boolean
}): ReactNode {
  return <EssentialityOptions {...props} includeUnset={false} onChange={(v) => onChange(v === 'unset' ? null : v)} />
}

/** Filter variant: adds "Not set" for spending with no essentiality. */
export function EssentialityFilterSelect(props: {
  value: Essentiality | 'unset' | ''
  onChange: (value: Schemas['EssentialityFilter'] | null) => void
  label: string
  allLabel: string
}): ReactNode {
  return <EssentialityOptions {...props} includeUnset />
}
