import { toast } from 'sonner'

/**
 * Confirmations and errors. Toast an action whose result is not already on screen (Sync, Recalculate,
 * rules, "Looks right", marking recurring); a control that shows its new value needs none.
 * Errors stay until dismissed. Mutation errors are toasted for every mutation by the query
 * client (app/queryClient.ts), so call `notifyError` only for failures outside a mutation.
 */
export function notify(message: string, action?: { label: string; onClick: () => void }) {
  toast.success(message, action && { action })
}

export function notifyError(title: string, error: unknown) {
  toast.error(title, {
    description: error instanceof Error ? error.message : String(error),
    duration: Infinity,
    closeButton: true,
  })
}
