import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { formatDateTime } from '@/lib/format'
import { useConnectSimplefin, useDisconnectSimplefin, useSimplefinStatus } from './queries'

export function BankConnectionCard() {
  const status = useSimplefinStatus()
  const connect = useConnectSimplefin()
  const disconnect = useDisconnectSimplefin()
  const [token, setToken] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (token.trim()) connect.mutate(token.trim(), { onSuccess: () => setToken('') })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bank connection</CardTitle>
        <CardDescription>Read-only access through SimpleFIN Bridge.</CardDescription>
      </CardHeader>
      <CardContent>
        {status.isPending ? null : status.data?.connected ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm">
              Connected{status.data.connected_at ? ` since ${formatDateTime(status.data.connected_at)}` : ''}
            </p>
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
              Disconnect
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-2">
            <div className="flex gap-2">
              <Input
                type="password"
                aria-label="SimpleFIN setup token"
                placeholder="Setup token"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <Button type="submit" variant="secondary" disabled={!token.trim() || connect.isPending}>
                Connect
              </Button>
            </div>
            {connect.error && (
              <p role="alert" className="text-sm text-destructive">
                {connect.error.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Get a setup token at{' '}
              <a
                href="https://bridge.simplefin.org"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                bridge.simplefin.org
              </a>
              .
            </p>
          </form>
        )}
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect bank?</DialogTitle>
            <DialogDescription>
              Syncing stops. Existing accounts and transactions are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate(undefined, { onSuccess: () => setConfirmOpen(false) })}
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
