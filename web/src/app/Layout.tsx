import { NavLink, Outlet } from 'react-router'
import { RefreshButton } from '@/app/RefreshButton'
import { TransactionPanelProvider } from '@/app/TransactionPanelProvider'
import { navItems } from '@/app/router'
import { useReviewCount } from '@/features/review/queries'
import { cn } from '@/lib/utils'

export function Layout() {
  const { count: reviewCount } = useReviewCount()
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <nav className="mx-auto flex max-w-6xl items-center gap-6 overflow-x-auto px-4 py-3">
          <span className="font-heading text-lg font-semibold tracking-tight">Plutus</span>
          <ul className="flex gap-1 text-sm">
            {navItems.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    cn(
                      'rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground',
                      isActive && 'bg-muted text-foreground',
                    )
                  }
                >
                  {item.label}
                  {item.to === '/review' && reviewCount > 0 && (
                    <>
                    {' '}
                    <span className="ml-1.5 rounded-full bg-muted-foreground/15 px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
                      {reviewCount}
                    </span>
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
          <RefreshButton />
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <TransactionPanelProvider>
          <Outlet />
        </TransactionPanelProvider>
      </main>
    </div>
  )
}
