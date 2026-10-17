import { Badge } from '@/components/ui/badge'
import { useLlmStatus } from './queries'

export function LlmStatusLine() {
  const llm = useLlmStatus()
  if (!llm.data) return null
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      Categorization model: {llm.data.provider} · {llm.data.model}
      {!llm.data.configured && (
        <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400">
          Not configured
        </Badge>
      )}
    </p>
  )
}
