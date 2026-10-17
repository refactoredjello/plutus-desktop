/**
 * Ollama implementation of LLMProvider over its HTTP chat API (no extra dependency). Ports
 * app/providers/llm/ollama.py.
 *
 * httpx becomes an injected `fetch`. httpx does not follow redirects, so neither does this; its
 * 300-second timeout becomes AbortSignal.timeout.
 */

import type { z } from 'zod'
import { ProviderError } from '../../lib/errors.js'
import {
  CLASSIFICATION_BATCH_JSON_SCHEMA,
  ClassificationBatch,
  SUGGESTION_BATCH_JSON_SCHEMA,
  SuggestionBatch,
  classifySystemPrompt,
  classifyUserMessage,
  savingsSystemPrompt,
  savingsUserMessage,
  toClassifications,
  toSuggestions,
} from './prompts.js'
import type {
  LLMProvider,
  MerchantClassification,
  MerchantInput,
  SavingsContext,
  SavingsSuggestion,
} from './types.js'

/** Local models can be slow on a cold start. */
export const TIMEOUT_SECONDS = 300

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

class Unusable extends Error {}

/** `value[key]` in Python: a dict lookup, KeyError or TypeError otherwise. */
function item(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key)) {
    throw new Unusable(key)
  }
  return (value as Record<string, unknown>)[key]
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama'
  readonly model: string
  private readonly url: string
  private readonly fetchFn: FetchFn

  constructor(baseUrl: string, model: string, fetchFn: FetchFn = globalThis.fetch) {
    this.model = model
    this.url = `${baseUrl.replace(/\/+$/, '')}/api/chat`
    this.fetchFn = fetchFn
  }

  async classifyMerchants(items: readonly MerchantInput[]): Promise<MerchantClassification[]> {
    if (items.length === 0) return []
    const batch = await this.chat(
      classifySystemPrompt(),
      classifyUserMessage(items),
      ClassificationBatch,
      CLASSIFICATION_BATCH_JSON_SCHEMA,
    )
    return toClassifications(batch)
  }

  async suggestSavings(context: SavingsContext): Promise<SavingsSuggestion[]> {
    const batch = await this.chat(
      savingsSystemPrompt(),
      savingsUserMessage(context),
      SuggestionBatch,
      SUGGESTION_BATCH_JSON_SCHEMA,
    )
    return toSuggestions(batch)
  }

  private async chat<S extends z.ZodType>(system: string, user: string, schema: S, format: object): Promise<z.infer<S>> {
    const body = {
      model: this.model,
      stream: false,
      format,
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }
    let response: Response
    let text: string
    try {
      response = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000),
      })
      text = await response.text()
    } catch {
      throw new ProviderError('Could not reach Ollama')
    }
    // raise_for_status: anything but 2xx.
    if (!response.ok) throw new ProviderError(`Ollama returned status ${response.status}`)
    try {
      const content = item(item(JSON.parse(text), 'message'), 'content')
      if (typeof content !== 'string') throw new Unusable('content')
      const result = schema.safeParse(JSON.parse(content))
      if (!result.success) throw new Unusable('validation')
      return result.data
    } catch {
      throw new ProviderError('Ollama returned an unusable response')
    }
  }
}
