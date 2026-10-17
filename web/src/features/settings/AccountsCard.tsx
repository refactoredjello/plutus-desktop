import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatMoney } from '@/lib/money'
import { useAccounts } from './queries'

export function AccountsCard() {
  const accounts = useAccounts()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounts</CardTitle>
      </CardHeader>
      <CardContent>
        {accounts.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : !accounts.data?.length ? (
          <p className="text-sm text-muted-foreground">No accounts yet. Connect your bank and sync.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Institution</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.data.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.name}</TableCell>
                  <TableCell className="text-muted-foreground">{a.institution_name ?? '—'}</TableCell>
                  <TableCell className="capitalize text-muted-foreground">{a.type}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(a.balance)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
