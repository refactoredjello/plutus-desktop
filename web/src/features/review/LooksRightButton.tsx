import { Button } from '@/components/ui/button'
import { useUpdateTransaction } from '@/features/transactions/queries'
import { notify } from '@/lib/toast'

/** Accepts the current category as correct: saving it as a manual choice clears the row from the queue. */
export function LooksRightButton({ id, categoryId }: { id: number; categoryId: number }) {
  const update = useUpdateTransaction()
  return (
    <Button
      size="xs"
      variant="ghost"
      className="text-muted-foreground"
      disabled={update.isPending}
      onClick={() => update.mutate({ id, body: { category_id: categoryId } }, { onSuccess: () => notify('Category confirmed') })}
    >
      Looks right
    </Button>
  )
}
