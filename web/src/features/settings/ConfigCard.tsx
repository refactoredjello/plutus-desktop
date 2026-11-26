import { useId, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { XIcon } from 'lucide-react'
import { api, unwrap, type Schemas } from '@/api/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'

type Config = Schemas['ConfigRead']
type Provider = Config['llm_provider']

const PROVIDERS: Record<Provider, string> = { claude: 'Claude', ollama: 'Ollama', fake: 'Fake (development)' }

/** Unsaved edits. Numbers stay as typed so the server, not the input, judges them. */
interface Draft {
  llm_provider?: Provider
  llm_model?: string
  ollama_base_url?: string
  owner_name_tokens?: string[]
  sync_interval_hours?: string
  sync_first_history_days?: string
  scheduler_enabled?: boolean
}

const NUMBER_FIELDS = ['sync_interval_hours', 'sync_first_history_days'] as const

/** Only what differs from the saved config. The key goes only when typed or cleared. */
function changes(saved: Config, draft: Draft, key: string, clearKey: boolean): Schemas['ConfigUpdate'] {
  const body: Schemas['ConfigUpdate'] = {}
  if (draft.llm_provider !== undefined && draft.llm_provider !== saved.llm_provider) body.llm_provider = draft.llm_provider
  for (const f of ['llm_model', 'ollama_base_url'] as const) {
    if (draft[f] !== undefined && draft[f] !== saved[f]) body[f] = draft[f]
  }
  for (const f of NUMBER_FIELDS) {
    const n = draft[f] === undefined ? undefined : Number(draft[f])
    if (n !== undefined && n !== saved[f]) body[f] = n
  }
  const tokens = draft.owner_name_tokens
  if (tokens && tokens.join('\n') !== saved.owner_name_tokens.join('\n')) body.owner_name_tokens = tokens
  if (draft.scheduler_enabled !== undefined && draft.scheduler_enabled !== saved.scheduler_enabled) {
    body.scheduler_enabled = draft.scheduler_enabled
  }
  if (clearKey) body.anthropic_api_key = null
  else if (key.trim()) body.anthropic_api_key = key.trim()
  return body
}

function useConfig() {
  return useQuery({ queryKey: ['settings', 'config'], queryFn: () => unwrap(api.GET('/api/settings/config')) })
}

function useUpdateConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['ConfigUpdate']) => unwrap(api.PUT('/api/settings/config', { body })),
    onSuccess: (config) => {
      qc.setQueryData(['settings', 'config'], config)
      return qc.invalidateQueries({ queryKey: ['settings'] })
    },
    // Shown beside Save, where a field-level complaint makes sense.
    meta: { inlineError: true },
  })
}

export function ConfigCard() {
  const titleId = useId()
  const config = useConfig()

  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId}>Configuration</CardTitle>
        <CardDescription>Categorization model and sync schedule.</CardDescription>
      </CardHeader>
      <CardContent>
        {config.data ? (
          <ConfigForm saved={config.data} />
        ) : config.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {config.error.message}
          </p>
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </CardContent>
    </Card>
  )
}

function ConfigForm({ saved }: { saved: Config }) {
  const id = useId()
  const update = useUpdateConfig()
  const [draft, setDraft] = useState<Draft>({})
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [token, setToken] = useState('')

  const provider = draft.llm_provider ?? saved.llm_provider
  const tokens = draft.owner_name_tokens ?? saved.owner_name_tokens
  const body = changes(saved, draft, key, clearKey)
  const dirty = Object.keys(body).length > 0
  const edit = (patch: Draft) => setDraft((d) => ({ ...d, ...patch }))

  function addToken(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const t = token.trim()
    if (t && !tokens.some((x) => x.toUpperCase() === t.toUpperCase())) edit({ owner_name_tokens: [...tokens, t] })
    setToken('')
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!dirty || update.isPending) return
    update.mutate(body, {
      onSuccess: () => {
        setDraft({})
        setKey('')
        setClearKey(false)
      },
    })
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>LLM provider</Label>
          <Select
            items={PROVIDERS}
            value={provider}
            onValueChange={(v) => v && edit({ llm_provider: v as Provider })}
          >
            <SelectTrigger aria-label="LLM provider" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PROVIDERS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-model`}>Model</Label>
          <Input
            id={`${id}-model`}
            value={draft.llm_model ?? saved.llm_model}
            onChange={(e) => edit({ llm_model: e.target.value })}
          />
        </div>

        {provider === 'claude' && (
          <div className="space-y-1.5 sm:col-span-2">
            <div className="flex items-center gap-2">
              <Label htmlFor={`${id}-key`}>Anthropic API key</Label>
              <Badge variant={saved.anthropic_api_key_set ? 'secondary' : 'outline'}>
                {saved.anthropic_api_key_set ? 'Set' : 'Not set'}
              </Badge>
            </div>
            {clearKey ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                The key will be removed when you save.
                <Button type="button" size="xs" variant="ghost" onClick={() => setClearKey(false)}>
                  Undo
                </Button>
              </p>
            ) : (
              <div className="flex gap-2">
                <Input
                  id={`${id}-key`}
                  type="password"
                  aria-label="New Anthropic API key"
                  placeholder={saved.anthropic_api_key_set ? 'Enter a new key to replace it' : 'Enter a key'}
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
                {saved.anthropic_api_key_set && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => {
                      setKey('')
                      setClearKey(true)
                    }}
                  >
                    Clear key
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {provider === 'ollama' && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${id}-ollama`}>Ollama URL</Label>
            <Input
              id={`${id}-ollama`}
              value={draft.ollama_base_url ?? saved.ollama_base_url}
              onChange={(e) => edit({ ollama_base_url: e.target.value })}
            />
          </div>
        )}

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${id}-token`}>Your name</Label>
          <p className="text-xs text-muted-foreground">
            Removed from merchant names before anything is sent for categorization.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {tokens.map((t) => (
              <Badge key={t} variant="secondary" className="pr-0.5">
                {t}
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                  onClick={() => edit({ owner_name_tokens: tokens.filter((x) => x !== t) })}
                >
                  <XIcon />
                </button>
              </Badge>
            ))}
            <Input
              id={`${id}-token`}
              aria-label="Add name token"
              placeholder="Add a name, press Enter"
              className="h-7 w-48"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={addToken}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${id}-hours`}>Sync every (hours)</Label>
          <Input
            id={`${id}-hours`}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            className="w-28"
            value={draft.sync_interval_hours ?? String(saved.sync_interval_hours)}
            onChange={(e) => edit({ sync_interval_hours: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-days`}>First sync history (days)</Label>
          <Input
            id={`${id}-days`}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            className="w-28"
            value={draft.sync_first_history_days ?? String(saved.sync_first_history_days)}
            onChange={(e) => edit({ sync_first_history_days: e.target.value })}
          />
        </div>

        <div className="flex items-center gap-3 sm:col-span-2">
          <Switch
            aria-label="Sync automatically"
            checked={draft.scheduler_enabled ?? saved.scheduler_enabled}
            onCheckedChange={(on) => edit({ scheduler_enabled: on })}
          />
          <span className="text-sm">Sync automatically</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="secondary" disabled={!dirty || update.isPending}>
          Save configuration
        </Button>
        {update.isSuccess && !dirty && (
          <span role="status" className="text-sm text-muted-foreground">
            Saved
          </span>
        )}
        {update.isError && (
          <p role="alert" className="text-sm text-destructive">
            {update.error.message}
          </p>
        )}
      </div>
    </form>
  )
}
