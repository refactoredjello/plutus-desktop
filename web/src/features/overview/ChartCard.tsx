import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

export function EmptyLine() {
  return (
    <p className="py-10 text-center text-sm text-muted-foreground">
      No data yet. Connect a bank in{' '}
      <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
        Settings
      </Link>
      , then press Sync in the header to pull in your transactions.
    </p>
  )
}

export function ErrorLine({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
      <p>Couldn’t load this card. {message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

/** A titled card that owns its own loading, error and empty states so one failure never breaks the page. */
export function ChartCard<T>({
  id,
  title,
  description,
  action,
  query,
  isEmpty,
  children,
  height = 260,
}: {
  id?: string
  title: string
  description?: string
  action?: ReactNode
  query: UseQueryResult<T>
  isEmpty: (data: T) => boolean
  children: (data: T) => ReactNode
  height?: number
}) {
  let body: ReactNode
  if (query.isPending) body = <Skeleton data-testid="card-skeleton" className="w-full" style={{ height }} />
  else if (query.isError) body = <ErrorLine message={query.error.message} onRetry={() => void query.refetch()} />
  else if (isEmpty(query.data)) body = <EmptyLine />
  else body = children(query.data)

  return (
    <Card id={id} className="viz min-w-0 scroll-mt-4">
      <CardHeader className="grid-cols-[1fr_auto]">
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {action}
      </CardHeader>
      <CardContent className="min-w-0">{body}</CardContent>
    </Card>
  )
}
