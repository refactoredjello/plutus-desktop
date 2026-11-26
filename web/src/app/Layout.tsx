import { useEffect, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { LastSynced } from '@/app/LastSynced'
import { RecalculateButton } from '@/app/RecalculateButton'
import { SyncButton } from '@/app/SyncButton'
import { TransactionPanelProvider } from '@/app/TransactionPanelProvider'
import { Toaster } from '@/components/ui/sonner'
import { navItems } from '@/app/router'
import { useReviewCount } from '@/features/review/queries'
import { cn } from '@/lib/utils'

export function Layout() {
  const { count: reviewCount } = useReviewCount()
  const links = useRef<HTMLUListElement>(null)
  const { pathname } = useLocation()
  // On a narrow window the links scroll; keep the current page's in view.
  useEffect(() => {
    links.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [pathname, reviewCount])
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b [view-transition-name:header]">
        <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <span className="shrink-0 font-heading text-lg font-semibold tracking-tight">Plutus</span>
          {/* Only the links scroll on a narrow window; the sync controls stay in view. */}
          <ul ref={links} className="flex min-w-0 flex-1 gap-1 overflow-x-auto text-sm">
            {navItems.map((item) => (
              <li key={item.to} className="shrink-0">
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  // A short cross-fade of the page; the header is excluded in index.css.
                  viewTransition
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
          <div className="flex shrink-0 items-center gap-2">
            <LastSynced />
            <RecalculateButton />
            <SyncButton />
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <TransactionPanelProvider>
          <Outlet />
        </TransactionPanelProvider>
      </main>
      <Toaster />
    </div>
  )
}
