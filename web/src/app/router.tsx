/**
 * All routes are registered here up front so feature briefs only edit their own page files.
 */
import { createBrowserRouter, type RouteObject } from 'react-router'
import { Layout } from '@/app/Layout'
import { GoalsPage } from '@/pages/Goals'
import { ManualEntriesPage } from '@/pages/ManualEntries'
import { MonthPage } from '@/pages/Month'
import { OverviewPage } from '@/pages/Overview'
import { RecurringPage } from '@/pages/Recurring'
import { ReviewPage } from '@/pages/Review'
import { SettingsPage } from '@/pages/Settings'
import { SpendingPage } from '@/pages/Spending'
import { TransactionsPage } from '@/pages/Transactions'

export const navItems = [
  { to: '/', label: 'Overview' },
  { to: '/month', label: 'Month' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/review', label: 'Review' },
  { to: '/recurring', label: 'Recurring' },
  { to: '/goals', label: 'Goals' },
  { to: '/planned', label: 'Planned' },
  { to: '/settings', label: 'Settings' },
] as const

export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'month', element: <MonthPage /> },
      { path: 'month/:month', element: <MonthPage /> },
      { path: 'transactions', element: <TransactionsPage /> },
      { path: 'review', element: <ReviewPage /> },
      { path: 'spending', element: <SpendingPage /> },
      { path: 'recurring', element: <RecurringPage /> },
      { path: 'goals', element: <GoalsPage /> },
      { path: 'planned', element: <ManualEntriesPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]

export const router = createBrowserRouter(routes)
