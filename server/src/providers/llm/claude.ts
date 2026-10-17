/**
 * Claude implementation of LLMProvider using the Anthropic SDK's structured outputs. Ports
 * app/providers/llm/claude.py.
 *
 * Python passed a pydantic model as `output_format`; the Python SDK sent its JSON schema as
 * `output_config.format` and validated the reply into `parsed_output`. Here the provider passes
 * the same JSON schema and a parser that validates with the Zod port of the pydantic model, and
 * the TypeScript SDK's `messages.parse` fills `parsed_output` with it.
 */

import Anthropic, {
  APIConnectionError,
  APIError,
  AnthropicError,
  type AutoParseableOutputFormat,
  RateLimitError,
} from '@anthropic-ai/sdk'
import type { z } from 'zod'
import { CONFIDENCES, ESSENTIALITIES } from '../../db/schema.js'
import { ProviderError } from '../../lib/errors.js'
import { type Logger, silentLogger } from '../../lib/log.js'
import {
  ClassificationBatch,
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

export const MAX_TOKENS = 8000

/** The part of the SDK client the provider uses; tests pass a stub. */
export type ClaudeClient = Pick<Anthropic, 'messages'>

/**
 * The schemas the Python SDK sent for ClassificationBatch and SuggestionBatch (its
 * transform_schema over pydantic's model_json_schema). The TypeScript SDK's zodOutputFormat
 * would move `enum` into a description, so Claude would no longer be held to the enum values.
 */
export const CLASSIFICATION_OUTPUT_SCHEMA = {
  $defs: {
    ClassifiedMerchant: {
      type: 'object',
      title: 'ClassifiedMerchant',
      properties: {
        merchant_key: { type: 'string', title: 'Merchant Key' },
        detailed_category: { type: 'string', title: 'Detailed Category' },
        essentiality: { $ref: '#/$defs/Essentiality' },
        confidence: { $ref: '#/$defs/Confidence' },
      },
      additionalProperties: false,
      required: ['merchant_key', 'detailed_category', 'essentiality', 'confidence'],
    },
    Confidence: {
      type: 'string',
      enum: [...CONFIDENCES],
      description: "Mirrors Plaid's confidence levels.",
      title: 'Confidence',
    },
    Essentiality: { type: 'string', enum: [...ESSENTIALITIES], title: 'Essentiality' },
  },
  type: 'object',
  title: 'ClassificationBatch',
  properties: {
    items: { type: 'array', title: 'Items', items: { $ref: '#/$defs/ClassifiedMerchant' } },
  },
  additionalProperties: false,
  required: ['items'],
}

export const SUGGESTION_OUTPUT_SCHEMA = {
  $defs: {
    SuggestedSaving: {
      type: 'object',
      title: 'SuggestedSaving',
      properties: {
        text: { type: 'string', title: 'Text' },
        category_label: { anyOf: [{ type: 'string' }, { type: 'null' }], title: 'Category Label' },
        estimated_monthly_saving: {
          anyOf: [{ type: 'number' }, { type: 'null' }],
          title: 'Estimated Monthly Saving',
        },
      },
      additionalProperties: false,
      required: ['text', 'category_label', 'estimated_monthly_saving'],
    },
  },
  type: 'object',
  title: 'SuggestionBatch',
  properties: {
    suggestions: { type: 'array', title: 'Suggestions', items: { $ref: '#/$defs/SuggestedSaving' } },
  },
  additionalProperties: false,
  required: ['suggestions'],
}

/**
 * An output format the SDK sends as `output_config.format` and parses replies with.
 * `onInvalid` records that the reply was not JSON or failed validation: Python saw pydantic's
 * ValidationError there, while the TypeScript SDK wraps any parse failure in AnthropicError.
 */
function outputFormat<S extends z.ZodType>(
  schema: S,
  jsonSchema: Record<string, unknown>,
  onInvalid: () => void,
): AutoParseableOutputFormat<z.infer<S>> {
  return {
    type: 'json_schema',
    schema: jsonSchema,
    parse: (content) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch (error) {
        onInvalid()
        throw error
      }
      const result = schema.safeParse(parsed)
      if (!result.success) {
        onInvalid()
        throw result.error
      }
      return result.data
    },
  }
}

/** The except chain in claude.py, in order. */
function toProviderError(error: unknown, invalid: boolean): unknown {
  if (invalid) return new ProviderError('Claude returned output that failed validation')
  if (error instanceof RateLimitError) return new ProviderError('Claude rate limit reached')
  // Python's APIStatusError: every APIError that carries an HTTP status.
  if (error instanceof APIError && typeof error.status === 'number') {
    return new ProviderError(`Claude API returned status ${error.status}`)
  }
  if (error instanceof APIConnectionError) return new ProviderError('Could not reach the Claude API')
  if (error instanceof AnthropicError) return new ProviderError(`Claude SDK error: ${error.constructor.name}`)
  return error
}

export class ClaudeProvider implements LLMProvider {
  readonly name = 'claude'
  readonly model: string
  private readonly client: ClaudeClient
  private readonly log: Logger

  constructor(apiKey: string, model: string, client?: ClaudeClient, log: Logger = silentLogger()) {
    this.model = model
    this.client = client ?? new Anthropic({ apiKey })
    this.log = log
  }

  async classifyMerchants(items: readonly MerchantInput[]): Promise<MerchantClassification[]> {
    if (items.length === 0) return []
    const batch = await this.parse(
      classifySystemPrompt(),
      classifyUserMessage(items),
      ClassificationBatch,
      CLASSIFICATION_OUTPUT_SCHEMA,
    )
    return toClassifications(batch)
  }

  async suggestSavings(context: SavingsContext): Promise<SavingsSuggestion[]> {
    const batch = await this.parse(
      savingsSystemPrompt(),
      savingsUserMessage(context),
      SuggestionBatch,
      SUGGESTION_OUTPUT_SCHEMA,
    )
    return toSuggestions(batch)
  }

  private async parse<S extends z.ZodType>(
    system: string,
    user: string,
    schema: S,
    jsonSchema: Record<string, unknown>,
  ): Promise<z.infer<S>> {
    let invalid = false
    const format = outputFormat(schema, jsonSchema, () => {
      invalid = true
    })
    let response
    try {
      response = await this.client.messages.parse({
        model: this.model,
        max_tokens: MAX_TOKENS,
        // The cache breakpoint sits on the (byte-stable) system block; the batch is in the
        // user message, after it.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
        output_config: { format },
      })
    } catch (error) {
      throw toProviderError(error, invalid)
    }

    if (response.stop_reason === 'refusal') throw new ProviderError('Claude declined the request')
    if (response.stop_reason === 'max_tokens') throw new ProviderError('Claude output was cut off at the token limit')
    if (response.parsed_output === null || response.parsed_output === undefined) {
      throw new ProviderError('Claude returned no structured output')
    }
    this.log.debug(
      {
        provider: this.name,
        model: this.model,
        cache_read: response.usage.cache_read_input_tokens,
        cache_write: response.usage.cache_creation_input_tokens,
      },
      'llm_call',
    )
    return response.parsed_output
  }
}
