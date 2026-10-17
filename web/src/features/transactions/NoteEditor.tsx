import { useState } from 'react'
import { StickyNote } from 'lucide-react'
import type { Schemas } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useUpdateTransaction } from './queries'

const MAX = 500

/** Small icon button that opens a popover to add, edit or clear the owner's private note. */
export function NoteEditor({ txn, label }: { txn: Schemas['TransactionRead']; label: string }) {
  const save = useUpdateTransaction()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const hasNote = !!txn.note

  function onOpenChange(next: boolean) {
    if (next) setDraft(txn.note ?? '')
    setOpen(next)
  }

  function commit(note: string | null) {
    setOpen(false)
    // Optimistic: the popover closes at once; a failure rolls back and shows on the row.
    save.mutate({ id: txn.id, body: { note } })
  }

  const text = draft.trim()
  const canSave = text !== (txn.note ?? '') && text.length <= MAX

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className={cn(
              'shrink-0 text-muted-foreground',
              // Quiet on desktop until the row is hovered or the button focused; always visible on small screens.
              !hasNote && 'sm:opacity-0 sm:group-hover/row:opacity-100 sm:focus-visible:opacity-100 sm:data-popup-open:opacity-100',
            )}
            aria-label={hasNote ? `Edit note for ${label}` : `Add note for ${label}`}
          />
        }
      >
        <StickyNote aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <Textarea
          aria-label={`Note for ${label}`}
          placeholder="Add a private note"
          maxLength={MAX}
          rows={3}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSave) {
              e.preventDefault()
              commit(text || null)
            }
          }}
        />
        <div className="flex items-center gap-2">
          <span className={cn('mr-auto text-xs text-muted-foreground', draft.length >= MAX - 50 && 'text-amber-700 dark:text-amber-400')}>
            {draft.length >= MAX - 50 ? `${draft.length}/${MAX}` : 'Ctrl/Cmd+Enter to save'}
          </span>
          {hasNote && (
            <Button size="sm" variant="ghost" onClick={() => commit(null)}>
              Clear
            </Button>
          )}
          <Button size="sm" disabled={!canSave} onClick={() => commit(text || null)}>
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
