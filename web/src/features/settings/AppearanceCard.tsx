import { Monitor, Moon, Sun } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAppearance, useSetAppearance } from './appearance'

const OPTIONS = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
] as const

/** Light, dark, or follow the system: applied at once, saved with the rest of the settings. */
export function AppearanceCard() {
  const appearance = useAppearance()
  const set = useSetAppearance()
  const current = appearance.data?.theme ?? 'system'
  return (
    <Card>
      <CardHeader>
        <CardTitle id="appearance-title">Appearance</CardTitle>
        <CardDescription>Follow the system, or always use light or dark.</CardDescription>
      </CardHeader>
      <CardContent>
        <div role="radiogroup" aria-labelledby="appearance-title" className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">
          {OPTIONS.map(({ value, label, Icon }) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground has-checked:bg-background has-checked:text-foreground has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-ring"
            >
              <input
                type="radio"
                name="appearance"
                value={value}
                checked={current === value}
                onChange={() => set.mutate(value)}
                className="sr-only"
              />
              <Icon aria-hidden className="size-3.5" />
              {label}
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
