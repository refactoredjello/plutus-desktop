/**
 * The LLM providers and the factory (the prompt tests live in prompts.test.ts), including the
 * fake provider.
 */

import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AnthropicError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from '@anthropic-ai/sdk'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderError } from '../src/lib/errors.js'
import { type Logger, createLogger } from '../src/lib/log.js'
import { cents } from '../src/lib/money.js'
import { type ClaudeClient, ClaudeProvider, MAX_TOKENS } from '../src/providers/llm/claude.js'
import { FakeLLMProvider } from '../src/providers/llm/fake.js'
import { type LlmSettings, getLlmProvider } from '../src/providers/llm/index.js'
import { OllamaProvider } from '../src/providers/llm/ollama.js'
import {
  CLASSIFICATION_BATCH_JSON_SCHEMA,
  ClassificationBatch,
  SUGGESTION_BATCH_JSON_SCHEMA,
  SuggestionBatch,
  classifySystemPrompt,
  classifyUserMessage,
  savingsSystemPrompt,
} from '../src/providers/llm/prompts.js'
import type { MerchantInput, SavingsContext } from '../src/providers/llm/types.js'
import { mockFetch } from './factories.js'
import { FIXTURES, testConfig } from './setup.js'

/**
 * The JSON schemas sent as output_config.format.schema, snapshotted in llm_prompts.json.
 */
const PY_SCHEMAS = (
  JSON.parse(readFileSync(join(FIXTURES, 'llm_prompts.json'), 'utf8')) as {
    claude_output_schemas: { ClassificationBatch: unknown; SuggestionBatch: unknown }
  }
).claude_output_schemas

const ITEMS: MerchantInput[] = [
  { merchant_key: 'BLUE BOTTLE COFFEE OAKLAND CA', amount_bucket: '<10', direction: 'outflow', account_kind: 'credit' },
  { merchant_key: 'ACME CORP PAYROLL', amount_bucket: '>1000', direction: 'inflow', account_kind: 'checking' },
]

const CONTEXT: SavingsContext = {
  goal_target: cents(500000),
  months_left: 6,
  monthly_gap: cents(30000),
  categories: [{ label: 'Restaurants', monthly_totals: [cents(20000), cents(25050)] }],
  recurring: [{ category_label: 'TV and movies', amount: cents(1549), cadence: 'monthly', essentiality: 'discretionary' }],
  excluded_suggestions: ['Cancel Netflix'],
}

function merchant(key: string): MerchantInput {
  return { merchant_key: key, amount_bucket: '10-50', direction: 'outflow', account_kind: 'credit' }
}

// --- fake -------------------------------------------------------------------------------------

describe('FakeLLMProvider', () => {
  it('classifies by the keyword table, in table order', async () => {
    const fake = new FakeLLMProvider()
    expect(fake.name).toBe('fake')
    const keys = [
      'ACME CORP PAYROLL',
      'BLUE BOTTLE COFFEE',
      'NETFLIX.COM',
      'SPOTIFY USA',
      'LOCAL GROCER',
      'FARMERS MARKET',
      'RENT PAYMENT',
      'CITY ELECTRIC',
      'SHELL OIL',
      'AMAZON MKTP',
      'RESTAURANT ROW',
      'MARKET COFFEE', // COFFEE comes before MARKET in the table
      'blue bottle coffee', // matching is case-sensitive
      'UNKNOWN VENDOR',
    ]
    const out = await fake.classifyMerchants(keys.map(merchant))
    expect(out.map((c) => [c.merchant_key, c.detailed_category, c.essentiality, c.confidence])).toEqual([
      ['ACME CORP PAYROLL', 'INCOME_SALARY', 'essential', 'high'],
      ['BLUE BOTTLE COFFEE', 'FOOD_AND_DRINK_COFFEE', 'discretionary', 'high'],
      ['NETFLIX.COM', 'ENTERTAINMENT_TV_AND_MOVIES', 'discretionary', 'high'],
      ['SPOTIFY USA', 'ENTERTAINMENT_MUSIC_AND_AUDIO', 'discretionary', 'high'],
      ['LOCAL GROCER', 'FOOD_AND_DRINK_GROCERIES', 'essential', 'high'],
      ['FARMERS MARKET', 'FOOD_AND_DRINK_GROCERIES', 'essential', 'high'],
      ['RENT PAYMENT', 'RENT_AND_UTILITIES_RENT', 'essential', 'high'],
      ['CITY ELECTRIC', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY', 'essential', 'high'],
      ['SHELL OIL', 'TRANSPORTATION_GAS', 'essential', 'high'],
      ['AMAZON MKTP', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', 'flexible', 'high'],
      ['RESTAURANT ROW', 'FOOD_AND_DRINK_RESTAURANT', 'discretionary', 'high'],
      ['MARKET COFFEE', 'FOOD_AND_DRINK_COFFEE', 'discretionary', 'high'],
      ['blue bottle coffee', 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE', 'flexible', 'low'],
      ['UNKNOWN VENDOR', 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE', 'flexible', 'low'],
    ])
  })

  it('records every classify call with a copy of the inputs', async () => {
    const fake = new FakeLLMProvider()
    const batch = [...ITEMS]
    await fake.classifyMerchants(batch)
    await fake.classifyMerchants([])
    batch.pop()
    expect(fake.classifyCalls).toEqual([ITEMS, []])
    expect(fake.suggestCalls).toEqual([])
  })

  it('suggests reviewing discretionary recurring charges that are not excluded', async () => {
    const fake = new FakeLLMProvider()
    const context: SavingsContext = {
      ...CONTEXT,
      recurring: [
        { category_label: 'TV and movies', amount: cents(1549), cadence: 'monthly', essentiality: 'discretionary' },
        { category_label: 'Gym', amount: cents(4000), cadence: 'monthly', essentiality: 'flexible' },
        { category_label: 'Music and audio', amount: cents(999), cadence: 'weekly', essentiality: 'discretionary' },
      ],
      excluded_suggestions: ['Review your Music and audio subscription (weekly).'],
    }
    expect(await fake.suggestSavings(context)).toEqual([
      { text: 'Review your TV and movies subscription (monthly).', category_label: 'TV and movies', estimated_monthly_saving: 1549 },
    ])
    expect(fake.suggestCalls).toEqual([context])
    expect(fake.classifyCalls).toEqual([])
  })

  it('falls back to a dining-out cap', async () => {
    const fake = new FakeLLMProvider()
    const context: SavingsContext = { ...CONTEXT, recurring: [], excluded_suggestions: [] }
    expect(await fake.suggestSavings(context)).toEqual([
      { text: 'Set a weekly cap on dining out.', category_label: null, estimated_monthly_saving: 5000 },
    ])
    const excluded: SavingsContext = { ...CONTEXT, excluded_suggestions: ['Review your TV and movies subscription (monthly).'] }
    expect((await fake.suggestSavings(excluded))[0]?.text).toBe('Set a weekly cap on dining out.')
  })
})

// --- Claude -----------------------------------------------------------------------------------

const RESULT: ClassificationBatch = {
  items: [
    { merchant_key: 'BLUE BOTTLE COFFEE OAKLAND CA', detailed_category: 'FOOD_AND_DRINK_COFFEE', essentiality: 'discretionary', confidence: 'high' },
    { merchant_key: 'ACME CORP PAYROLL', detailed_category: 'INCOME_SALARY', essentiality: 'essential', confidence: 'very_high' },
  ],
}

interface StubResponse {
  parsed_output: unknown
  stop_reason: string
  usage: { cache_read_input_tokens: number; cache_creation_input_tokens: number }
}

function response(parsed: unknown, stopReason = 'end_turn'): StubResponse {
  return { parsed_output: parsed, stop_reason: stopReason, usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
}

interface ParseParams {
  model: string
  max_tokens: number
  system: { type: string; text: string; cache_control: unknown }[]
  messages: { role: string; content: string }[]
  output_config: { format: { type: string; schema: unknown; parse: (text: string) => unknown } }
}

/** The MagicMock client: `parse` resolves to `stub` or rejects with `error`. */
function claude(stub: StubResponse | null = null, error?: unknown, log?: Logger) {
  const parse = vi.fn(async (_params: ParseParams) => {
    if (error !== undefined) throw error
    return stub ?? response(RESULT)
  })
  const client = { messages: { parse } } as unknown as ClaudeClient
  return { provider: new ClaudeProvider('sk-test', 'claude-haiku-4-5', client, log), parse }
}

function call(parse: ReturnType<typeof claude>['parse'], index = 0): ParseParams {
  return parse.mock.calls[index]?.[0] as ParseParams
}

async function providerError(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError)
    return error as ProviderError
  }
  throw new Error('expected a ProviderError')
}

describe('ClaudeProvider', () => {
  it('sends the expected request shape', async () => {
    const { provider, parse } = claude()
    const out = await provider.classifyMerchants(ITEMS)

    const kwargs = call(parse)
    expect(kwargs.model).toBe('claude-haiku-4-5')
    expect(kwargs.max_tokens).toBe(MAX_TOKENS)
    expect(MAX_TOKENS).toBe(8000)
    expect(kwargs.output_config.format.type).toBe('json_schema')
    expect(kwargs.output_config.format.schema).toEqual(PY_SCHEMAS.ClassificationBatch)
    expect(kwargs).not.toHaveProperty('thinking')
    const system = kwargs.system
    expect(system[0]?.text).toBe(classifySystemPrompt())
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' })
    const user = kwargs.messages[0]?.content ?? ''
    expect(kwargs.messages[0]?.role).toBe('user')
    expect(user).toBe(classifyUserMessage(ITEMS))
    expect(user).toContain('BLUE BOTTLE COFFEE OAKLAND CA')
    expect(user).toContain('outflow')

    expect(out.map((c) => c.merchant_key)).toEqual(ITEMS.map((i) => i.merchant_key))
    expect(out[0]?.detailed_category).toBe('FOOD_AND_DRINK_COFFEE')
    expect(out[0]?.essentiality).toBe('discretionary')
    expect(out[1]?.confidence).toBe('very_high')
  })

  it('keeps the system prompt identical across calls', async () => {
    const { provider, parse } = claude()
    await provider.classifyMerchants(ITEMS)
    await provider.classifyMerchants(ITEMS.slice(0, 1))
    expect(call(parse, 0).system).toEqual(call(parse, 1).system)
    expect(call(parse, 0).messages).not.toEqual(call(parse, 1).messages)
  })

  it('makes no call for an empty batch', async () => {
    const { provider, parse } = claude()
    expect(await provider.classifyMerchants([])).toEqual([])
    expect(parse).not.toHaveBeenCalled()
  })

  it.each([
    ['refusal', 'Claude declined the request'],
    ['max_tokens', 'Claude output was cut off at the token limit'],
  ])('raises ProviderError on stop reason %s', async (stopReason, message) => {
    const { provider } = claude(response(RESULT, stopReason))
    expect((await providerError(provider.classifyMerchants(ITEMS))).detail).toBe(message)
  })

  it('raises ProviderError when parsed output is missing', async () => {
    const { provider } = claude(response(null))
    expect((await providerError(provider.classifyMerchants(ITEMS))).detail).toBe('Claude returned no structured output')
  })

  const headers = new Headers()
  const body = { error: { message: 'x' } }
  it.each([
    ['RateLimitError', new RateLimitError(429, body, 'slow down', headers), 'Claude rate limit reached'],
    ['InternalServerError', new InternalServerError(500, body, 'oops', headers), 'Claude API returned status 500'],
    ['AuthenticationError', new AuthenticationError(401, body, 'bad key', headers), 'Claude API returned status 401'],
    ['APIConnectionError', new APIConnectionError({}), 'Could not reach the Claude API'],
    ['APIConnectionTimeoutError', new APIConnectionTimeoutError(), 'Could not reach the Claude API'],
  ] as const)('turns %s into a ProviderError', async (_name, error, message) => {
    const { provider } = claude(null, error)
    expect((await providerError(provider.classifyMerchants(ITEMS))).detail).toBe(message)
    expect((await providerError(provider.suggestSavings(CONTEXT))).detail).toBe(message)
  })

  it.each([
    ['BadRequestError', new BadRequestError(400, body, 'bad', headers), 'Claude API returned status 400'],
    ['PermissionDeniedError', new PermissionDeniedError(403, body, 'no', headers), 'Claude API returned status 403'],
    ['NotFoundError', new NotFoundError(404, body, 'gone', headers), 'Claude API returned status 404'],
    ['ConflictError', new ConflictError(409, body, 'conflict', headers), 'Claude API returned status 409'],
    ['UnprocessableEntityError', new UnprocessableEntityError(422, body, 'bad', headers), 'Claude API returned status 422'],
    ['InternalServerError 529', new InternalServerError(529, body, 'overloaded', headers), 'Claude API returned status 529'],
    ['APIError 418', new APIError(418, body, 'teapot', headers), 'Claude API returned status 418'],
    ['APIUserAbortError', new APIUserAbortError(), 'Claude SDK error: APIUserAbortError'],
    ['AnthropicError', new AnthropicError('other'), 'Claude SDK error: AnthropicError'],
  ] as const)('maps every other SDK error class: %s', async (_name, error, message) => {
    const { provider } = claude(null, error)
    expect((await providerError(provider.classifyMerchants(ITEMS))).detail).toBe(message)
  })

  it('suggests savings from aggregates only', async () => {
    const parsed: SuggestionBatch = {
      suggestions: [
        { text: 'Cook at home twice a week.', category_label: 'Restaurants', estimated_monthly_saving: 40.5 },
        { text: 'Review subscriptions.', category_label: null, estimated_monthly_saving: null },
      ],
    }
    const { provider, parse } = claude(response(parsed))
    const out = await provider.suggestSavings(CONTEXT)

    const kwargs = call(parse)
    expect(kwargs.output_config.format.schema).toEqual(PY_SCHEMAS.SuggestionBatch)
    expect(kwargs.system[0]?.text).toBe(savingsSystemPrompt())
    expect(kwargs.system[0]?.cache_control).toEqual({ type: 'ephemeral' })
    const user = kwargs.messages[0]?.content ?? ''
    const payload = JSON.parse(user.split('\n').slice(1).join('\n')) as Record<string, unknown>
    expect(payload.excluded_suggestions).toEqual(['Cancel Netflix'])
    expect(payload.monthly_gap).toBe('300.00')
    expect((payload.categories as unknown[])[0]).toEqual({ label: 'Restaurants', monthly_totals: ['200.00', '250.50'] })
    expect(user.toLowerCase()).not.toContain('merchant')
    expect(out[0]?.estimated_monthly_saving).toBe(4050)
    expect(out[1]?.estimated_monthly_saving).toBeNull()

    // Savings prompt is also stable across calls.
    await provider.suggestSavings(CONTEXT)
    expect(call(parse, 0).system).toEqual(call(parse, 1).system)
  })

  it('logs cache usage at debug, never the prompt or the key', async () => {
    const lines: string[] = []
    const log = createLogger({ level: 'debug' }, { write: (line: string) => void lines.push(line) })
    const stub = { ...response(RESULT), usage: { cache_read_input_tokens: 4100, cache_creation_input_tokens: 7 } }
    await claude(stub, undefined, log).provider.classifyMerchants(ITEMS)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 'debug',
      msg: 'llm_call',
      provider: 'claude',
      model: 'claude-haiku-4-5',
      cache_read: 4100,
      cache_write: 7,
    })
    expect(lines[0]).not.toContain('sk-test')
    expect(lines[0]).not.toContain('BLUE BOTTLE')
  })
})

/** A real SDK client over a stubbed fetch, to check the wire request and the SDK's parsing. */
function sdkClaude(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = []
  const client = new Anthropic({ apiKey: 'sk-test', maxRetries: 0, fetch: mockFetch(handler, requests) })
  return { provider: new ClaudeProvider('sk-test', 'claude-haiku-4-5', client), requests }
}

function message(text: string, stopReason = 'end_turn'): Response {
  return Response.json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
}

describe('ClaudeProvider over the real SDK', () => {
  it('sends the system block with the cache breakpoint and the JSON schema format', async () => {
    const { provider, requests } = sdkClaude(() => message(JSON.stringify(RESULT)))
    const out = await provider.classifyMerchants(ITEMS)
    expect(out).toEqual(RESULT.items)
    const sent = (await requests[0]?.json()) as Record<string, unknown>
    expect(requests[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(requests[0]?.headers.get('x-api-key')).toBe('sk-test')
    expect(sent).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 8000,
      system: [{ type: 'text', text: classifySystemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: classifyUserMessage(ITEMS) }],
      output_config: { format: { type: 'json_schema', schema: PY_SCHEMAS.ClassificationBatch } },
    })
    expect(sent).not.toHaveProperty('thinking')
    expect(sent.output_config).toEqual({ format: { type: 'json_schema', schema: PY_SCHEMAS.ClassificationBatch } })
  })

  it('reports output that fails validation', async () => {
    for (const text of ['{"items": [{"merchant_key": "X"}]}', 'not json', '{"items": [{"merchant_key": "X"']) {
      const { provider } = sdkClaude(() => message(text))
      expect((await providerError(provider.classifyMerchants(ITEMS))).detail).toBe(
        'Claude returned output that failed validation',
      )
    }
  })

  it('maps HTTP errors through the SDK classes', async () => {
    const statuses: [number, string][] = [
      [429, 'Claude rate limit reached'],
      [500, 'Claude API returned status 500'],
      [401, 'Claude API returned status 401'],
    ]
    for (const [status, detail] of statuses) {
      const { provider } = sdkClaude(() => Response.json({ type: 'error', error: { type: 'x', message: 'x' } }, { status }))
      expect((await providerError(provider.classifyMerchants(ITEMS))).detail).toBe(detail)
    }
    const down = sdkClaude(() => {
      throw new TypeError('fetch failed')
    })
    expect((await providerError(down.provider.classifyMerchants(ITEMS))).detail).toBe('Could not reach the Claude API')
  })
})

// --- Ollama -----------------------------------------------------------------------------------

function ollama(handler: (request: Request) => Response | Promise<Response>, requests?: Request[]): OllamaProvider {
  return new OllamaProvider('http://ollama.test:11434/', 'llama3.1', mockFetch(handler, requests))
}

describe('OllamaProvider', () => {
  it('sends the chat request and parses the reply', async () => {
    const seen: Request[] = []
    const handler = () => Response.json({ message: { role: 'assistant', content: JSON.stringify(RESULT) } })
    const out = await ollama(handler, seen).classifyMerchants(ITEMS)
    const request = seen[0] as Request
    expect(request.url).toBe('http://ollama.test:11434/api/chat')
    expect(request.method).toBe('POST')
    expect(request.headers.get('content-type')).toBe('application/json')
    expect(request.redirect).toBe('manual')
    const body = (await request.json()) as Record<string, unknown>
    expect(body.model).toBe('llama3.1')
    expect(body.stream).toBe(false)
    expect(body.format).toEqual(CLASSIFICATION_BATCH_JSON_SCHEMA)
    expect(body.options).toEqual({ temperature: 0 })
    const messages = body.messages as { role: string; content: string }[]
    expect(messages[0]).toEqual({ role: 'system', content: classifySystemPrompt() })
    expect(messages[1]).toEqual({ role: 'user', content: classifyUserMessage(ITEMS) })
    expect(messages[1]?.content).toContain('ACME CORP PAYROLL')
    expect(out.map((c) => c.detailed_category)).toEqual(['FOOD_AND_DRINK_COFFEE', 'INCOME_SALARY'])
  })

  it('suggests savings', async () => {
    const content = JSON.stringify({ suggestions: [{ text: 'Trim dining.', category_label: null, estimated_monthly_saving: 20 }] })
    const seen: Request[] = []
    const out = await ollama(() => Response.json({ message: { content } }), seen).suggestSavings(CONTEXT)
    const body = (await seen[0]?.json()) as Record<string, unknown>
    expect(body.format).toEqual(SUGGESTION_BATCH_JSON_SCHEMA)
    expect((body.messages as { content: string }[])[0]?.content).toBe(savingsSystemPrompt())
    expect(out[0]?.estimated_monthly_saving).toBe(2000)
  })

  it('makes no call for an empty batch', async () => {
    const seen: Request[] = []
    expect(await ollama(() => Response.json({}), seen).classifyMerchants([])).toEqual([])
    expect(seen).toHaveLength(0)
  })

  it.each([
    ['HTTP 500', () => new Response('boom', { status: 500 }), 'Ollama returned status 500'],
    ['a redirect', () => new Response(null, { status: 301, headers: { location: 'http://x/' } }), 'Ollama returned status 301'],
    ['not JSON', () => new Response('not json'), 'Ollama returned an unusable response'],
    ['an empty object', () => Response.json({ message: { content: '{}' } }), 'Ollama returned an unusable response'],
    [
      'missing fields',
      () => Response.json({ message: { content: '{"items": [{"merchant_key": "X"}]}' } }),
      'Ollama returned an unusable response',
    ],
    ['no message', () => Response.json({ unexpected: true }), 'Ollama returned an unusable response'],
    ['a null message', () => Response.json({ message: null }), 'Ollama returned an unusable response'],
    ['a list', () => Response.json([{ message: { content: '{}' } }]), 'Ollama returned an unusable response'],
    ['non-string content', () => Response.json({ message: { content: RESULT } }), 'Ollama returned an unusable response'],
    ['content that is not JSON', () => Response.json({ message: { content: 'sure!' } }), 'Ollama returned an unusable response'],
  ] as const)('raises ProviderError for %s', async (_name, handler, detail) => {
    expect((await providerError(ollama(handler).classifyMerchants(ITEMS))).detail).toBe(detail)
  })

  it('raises ProviderError when Ollama cannot be reached', async () => {
    const refused = () => {
      throw new TypeError('fetch failed')
    }
    expect((await providerError(ollama(refused).classifyMerchants(ITEMS))).detail).toBe('Could not reach Ollama')
    const slow = () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }
    expect((await providerError(ollama(slow).suggestSavings(CONTEXT))).detail).toBe('Could not reach Ollama')
  })
})

// --- factory ----------------------------------------------------------------------------------

/** The default LLM knobs, with overrides. */
function llmSettings(overrides: Partial<LlmSettings> = {}): LlmSettings {
  return {
    llm_provider: 'fake',
    llm_model: 'claude-haiku-4-5',
    anthropic_api_key: null,
    ollama_base_url: 'http://localhost:11434',
    ...overrides,
  }
}

describe('getLlmProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('returns each provider', () => {
    expect(getLlmProvider(llmSettings({ llm_provider: 'fake' }))).toBeInstanceOf(FakeLLMProvider)
    const claude = getLlmProvider(llmSettings({ llm_provider: 'claude', anthropic_api_key: 'sk-test' }))
    expect(claude).toBeInstanceOf(ClaudeProvider)
    expect((claude as ClaudeProvider).model).toBe('claude-haiku-4-5')
    const ollama = getLlmProvider(llmSettings({ llm_provider: 'ollama', llm_model: 'llama3.1' }))
    expect(ollama).toBeInstanceOf(OllamaProvider)
    expect((ollama as OllamaProvider).model).toBe('llama3.1')
  })

  it('requires an API key for Claude', () => {
    for (const key of [null, '', '  \n']) {
      expect(() => getLlmProvider(llmSettings({ llm_provider: 'claude', anthropic_api_key: key }))).toThrow(ProviderError)
    }
    expect(() => getLlmProvider(llmSettings({ llm_provider: 'claude' }))).toThrow(
      'LLM_PROVIDER=claude requires ANTHROPIC_API_KEY to be set',
    )
  })

  it('uses only the settings it is given, never the environment', async () => {
    vi.stubEnv('LLM_PROVIDER', 'claude')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-from-env')
    vi.stubEnv('OLLAMA_BASE_URL', 'http://env.example:1')
    expect(getLlmProvider(llmSettings())).toBeInstanceOf(FakeLLMProvider)
    expect(() => getLlmProvider(llmSettings({ llm_provider: 'claude' }))).toThrow(ProviderError)

    const seen: Request[] = []
    vi.stubGlobal('fetch', mockFetch(() => Response.json({ message: { content: JSON.stringify(RESULT) } }), seen))
    const ollama = getLlmProvider(llmSettings({ llm_provider: 'ollama', ollama_base_url: 'http://ollama.test:11434/' }))
    await ollama.classifyMerchants(ITEMS)
    expect(seen[0]?.url).toBe('http://ollama.test:11434/api/chat')
  })

  it('defaults the model to an alias with no date suffix', () => {
    expect(testConfig().defaults.llmModel).toBe('claude-haiku-4-5')
  })
})
