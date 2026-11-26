import {
  Banknote,
  CalendarClock,
  CalendarX,
  Circle,
  Gauge,
  Repeat,
  Sparkles,
  Tag,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import type { Schemas } from '@/api/client'
import { useChanges, useDismissChange } from './queries'

type Item = Schemas['ChangeItem']

const EMPHASISED = new Set(['S1', 'S2', 'S3', 'S9'])

const WARN = 'text-amber-600 dark:text-amber-400'
const QUIET = 'text-muted-foreground'

/** A marker per signal (services/changes.ts), so the list scans by kind. */
const MARKERS: Record<string, [LucideIcon, string]> = {
  S1: [Repeat, WARN], // a recurring charge changed price
  S2: [CalendarX, 'text-destructive'], // a recurring charge is missing
  S3: [CalendarClock, WARN], // a planned entry is overdue
  S4: [TrendingUp, WARN], // a category is above its usual pace
  S5: [Sparkles, QUIET], // a first-time merchant
  S6: [Banknote, WARN], // a large expense
  S7: [Tag, QUIET], // transactions need review
  S8: [Gauge, WARN], // discretionary pace
  S9: [TrendingDown, 'text-destructive'], // projected balance below zero
}

function Marker({ signal }: { signal: string }) {
  const [Icon, tone] = MARKERS[signal] ?? [Circle, QUIET]
  return <Icon aria-hidden data-signal={signal} className={`size-4 shrink-0 ${tone}`} />
}
const MONEY = /[\u2212-]?\$\d[\d,]*(?:\.\d+)?/g

/** The figure in the sentence that matches `amount` (the backend rounds to whole dollars from $100). */
function findAmount(text: string, amount: string | null): RegExpExecArray | null {
  if (amount === null) return null
  const target = Math.abs(Number(amount))
  for (const m of text.matchAll(MONEY)) {
    const value = Math.abs(Number(m[0].replace(/[^\d.]/g, '')))
    if (Math.abs(value - target) < 0.5) return m as RegExpExecArray
  }
  return null
}

/** The sentence, with its headline figure (the item's `amount`) in the destructive colour for the signals that call for it. */
function Sentence({ item }: { item: Item }) {
  const m = EMPHASISED.has(item.signal) ? findAmount(item.text, item.amount) : null
  if (!m) return <>{item.text}</>
  return (
    <>
      {item.text.slice(0, m.index)}
      <span data-testid="change-amount" className="text-destructive">
        {m[0]}
      </span>
      {item.text.slice(m.index + m[0].length)}
    </>
  )
}

function scrollToHash(href: string) {
  const hash = href.split('#')[1]
  if (!hash) return
  // Same-page hash navigation does not scroll on its own under the data router.
  requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }))
}

export function ChangesCard() {
  const [expanded, setExpanded] = useState(false)
  const changes = useChanges(expanded)
  const dismiss = useDismissChange()

  let body: ReactNode
  if (changes.isPending) {
    body = <Skeleton data-testid="changes-skeleton" className="h-5 w-64 max-w-full" />
  } else if (changes.isError) {
    body = (
      <div role="alert" className="flex items-center gap-3 text-sm text-muted-foreground">
        <p>Couldn’t load what changed.</p>
        <Button variant="outline" size="sm" onClick={() => void changes.refetch()}>
          Retry
        </Button>
      </div>
    )
  } else if (changes.data.items.length === 0) {
    body = <p className="text-sm text-muted-foreground">Nothing unusual this month.</p>
  } else {
    const { items, hidden } = changes.data
    body = (
      <div>
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.key} className="group flex items-center gap-2 py-1.5 text-sm">
              <Link
                to={item.href}
                onClick={() => scrollToHash(item.href)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm hover:underline focus-visible:underline"
              >
                <Marker signal={item.signal} />
                <span className="min-w-0">
                  <Sentence item={item} />
                </span>
              </Link>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Dismiss: ${item.text}`}
                className="shrink-0 text-muted-foreground opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                onClick={() => dismiss.mutate(item.key)}
              >
                <span aria-hidden="true">×</span>
              </Button>
            </li>
          ))}
        </ul>
        {!expanded && hidden > 0 && (
          <Button variant="link" size="sm" className="mt-1 h-auto px-0" onClick={() => setExpanded(true)}>
            {hidden} more
          </Button>
        )}
        {expanded && (
          <Button variant="link" size="sm" className="mt-1 h-auto px-0" onClick={() => setExpanded(false)}>
            Show fewer
          </Button>
        )}
      </div>
    )
  }

  const description =
    changes.data?.average_months === 3 ? 'Compared with your usual three months.' : 'Compared with your average so far.'

  return (
    <Card>
      <CardHeader>
        <CardTitle>What changed</CardTitle>
        {!changes.isError && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  )
}
