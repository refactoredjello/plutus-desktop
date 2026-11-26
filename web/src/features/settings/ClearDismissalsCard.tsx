import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useClearDismissals } from '@/features/overview/queries'

export function ClearDismissalsCard() {
  const clear = useClearDismissals()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Dismissed changes</CardTitle>
        <CardDescription>Bring back everything you dismissed from “What changed” on Overview.</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        <Button variant="secondary" size="sm" disabled={clear.isPending} onClick={() => clear.mutate()}>
          Clear dismissed changes
        </Button>
        {clear.isSuccess && (
          <span role="status" className="text-sm text-muted-foreground">
            Cleared
          </span>
        )}
      </CardContent>
    </Card>
  )
}
