import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRightIcon } from 'lucide-react'
import { api, unwrap, type Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { humanizeEnum } from '@/lib/format'

type Category = Schemas['CategoryRead']

function useCategoryMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ['categories'] })
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: number } & Schemas['CategoryUpdate']) =>
      unwrap(api.PATCH('/api/categories/{category_id}', { params: { path: { category_id: id } }, body })),
    onSuccess: invalidate,
    meta: { inlineError: true },
  })
  const create = useMutation({
    mutationFn: (body: Schemas['CategoryCreate']) => unwrap(api.POST('/api/categories', { body })),
    onSuccess: invalidate,
    meta: { inlineError: true },
  })
  return { update, create }
}

function CategoryRow({ category, onRename, onToggle }: {
  category: Category
  onRename: (label: string) => void
  onToggle: (hidden: boolean) => void
}) {
  const [label, setLabel] = useState(category.label)
  function commit() {
    const next = label.trim()
    if (!next) setLabel(category.label)
    else if (next !== category.label) onRename(next)
  }
  return (
    <li className="flex items-center gap-3 py-1">
      <Input
        aria-label={`Rename ${category.label}`}
        className="h-7 border-transparent bg-transparent shadow-none hover:border-input focus-visible:border-ring"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <Switch
        size="sm"
        aria-label={`Show ${category.label}`}
        checked={!category.is_hidden}
        onCheckedChange={(visible) => onToggle(!visible)}
      />
    </li>
  )
}

export function CategoriesCard() {
  const { update, create } = useCategoryMutations()
  const categories = useQuery({
    queryKey: ['categories', { includeHidden: true }],
    queryFn: () => unwrap(api.GET('/api/categories', { params: { query: { include_hidden: true } } })),
  })
  const [newPrimary, setNewPrimary] = useState('')
  const [newLabel, setNewLabel] = useState('')

  const groups = new Map<string, Category[]>()
  for (const c of categories.data ?? []) groups.set(c.primary, [...(groups.get(c.primary) ?? []), c])

  function onAdd(e: FormEvent) {
    e.preventDefault()
    if (!newLabel.trim() || !newPrimary) return
    create.mutate({ primary: newPrimary, label: newLabel.trim() }, { onSuccess: () => setNewLabel('') })
  }

  const error = (update.error ?? create.error)?.message

  return (
    <Card>
      <CardHeader>
        <CardTitle>Categories</CardTitle>
        <CardDescription>Rename, hide, or add your own. Hidden categories are not offered when editing.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="divide-y rounded-lg border">
          {[...groups].map(([primary, items]) => (
            <Collapsible key={primary} className="px-3">
              <CollapsibleTrigger className="group flex w-full items-center gap-2 py-2 text-left text-sm font-medium">
                <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
                {humanizeEnum(primary)}
                <span className="text-xs font-normal text-muted-foreground">{items.length}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="pb-2 pl-6">
                  {items.map((c) => (
                    <CategoryRow
                      key={`${c.id}-${c.label}`}
                      category={c}
                      onRename={(label) => update.mutate({ id: c.id, label })}
                      onToggle={(is_hidden) => update.mutate({ id: c.id, is_hidden })}
                    />
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
        <form onSubmit={onAdd} className="flex flex-wrap gap-2">
          <Select
            items={Object.fromEntries([...groups.keys()].map((p) => [p, humanizeEnum(p)]))}
            value={newPrimary || null}
            onValueChange={(v) => setNewPrimary(v ?? '')}
          >
            <SelectTrigger aria-label="New category group" className="w-48">
              <SelectValue placeholder="Group" />
            </SelectTrigger>
            <SelectContent>
              {[...groups.keys()].map((p) => (
                <SelectItem key={p} value={p}>
                  {humanizeEnum(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="New category name"
            placeholder="New category"
            className="w-48"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={!newPrimary || !newLabel.trim() || create.isPending}>
            Add
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
