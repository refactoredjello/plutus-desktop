/**
 * Provider factory for the LLM boundary.
 *
 * The caller passes the four LLM knobs explicitly (the config service supplies them from
 * app_settings). Nothing here reads the environment.
 */

import type { LLMProviderName } from '../../config.js'
import { ProviderError } from '../../lib/errors.js'
import type { Logger } from '../../lib/log.js'
import { ClaudeProvider } from './claude.js'
import { FakeLLMProvider } from './fake.js'
import { OllamaProvider } from './ollama.js'
import type { LLMProvider } from './types.js'

export interface LlmSettings {
  llm_provider: LLMProviderName
  llm_model: string
  anthropic_api_key: string | null
  ollama_base_url: string
}

/** Blank strings: empty or only whitespace (ASCII, \x1c-\x1f, and the Unicode spaces). */
// oxlint-disable-next-line no-control-regex -- \x1c-\x1f count as whitespace.
const PY_BLANK = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/

/** `log` reaches the Claude provider's debug line. */
export function getLlmProvider(settings: LlmSettings, log?: Logger): LLMProvider {
  switch (settings.llm_provider) {
    case 'fake':
      return new FakeLLMProvider()
    case 'claude': {
      const key = settings.anthropic_api_key
      if (key === null || PY_BLANK.test(key)) {
        throw new ProviderError('LLM_PROVIDER=claude requires ANTHROPIC_API_KEY to be set')
      }
      return new ClaudeProvider(key, settings.llm_model, undefined, log)
    }
    case 'ollama':
      return new OllamaProvider(settings.ollama_base_url, settings.llm_model)
  }
}
