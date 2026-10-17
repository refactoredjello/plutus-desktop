"""Claude implementation of LLMProvider using the Anthropic SDK's structured outputs."""

import anthropic
import structlog
from pydantic import BaseModel, ValidationError

from app.errors import ProviderError
from app.providers.llm.base import (
    MerchantClassification,
    MerchantInput,
    SavingsContext,
    SavingsSuggestion,
)
from app.providers.llm.prompts import (
    ClassificationBatch,
    SuggestionBatch,
    classify_system_prompt,
    classify_user_message,
    savings_system_prompt,
    savings_user_message,
    to_classifications,
    to_suggestions,
)

log = structlog.get_logger()

MAX_TOKENS = 8000


class ClaudeProvider:
    name = "claude"

    def __init__(
        self,
        api_key: str,
        model: str,
        client: anthropic.Anthropic | None = None,
    ) -> None:
        self.model = model
        self._client = client or anthropic.Anthropic(api_key=api_key)

    def classify_merchants(self, items: list[MerchantInput]) -> list[MerchantClassification]:
        if not items:
            return []
        batch = self._parse(
            classify_system_prompt(), classify_user_message(items), ClassificationBatch
        )
        return to_classifications(batch)

    def suggest_savings(self, context: SavingsContext) -> list[SavingsSuggestion]:
        batch = self._parse(savings_system_prompt(), savings_user_message(context), SuggestionBatch)
        return to_suggestions(batch)

    def _parse[M: BaseModel](self, system: str, user: str, output_format: type[M]) -> M:
        try:
            response = self._client.messages.parse(
                model=self.model,
                max_tokens=MAX_TOKENS,
                # The cache breakpoint sits on the (byte-stable) system block; the batch is
                # in the user message, after it.
                system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": user}],
                output_format=output_format,
            )
        except anthropic.RateLimitError as exc:
            raise ProviderError("Claude rate limit reached") from exc
        except anthropic.APIStatusError as exc:
            raise ProviderError(f"Claude API returned status {exc.status_code}") from exc
        except anthropic.APIConnectionError as exc:
            raise ProviderError("Could not reach the Claude API") from exc
        except anthropic.AnthropicError as exc:
            raise ProviderError(f"Claude SDK error: {type(exc).__name__}") from exc
        except ValidationError as exc:
            raise ProviderError("Claude returned output that failed validation") from exc

        if response.stop_reason == "refusal":
            raise ProviderError("Claude declined the request")
        if response.stop_reason == "max_tokens":
            raise ProviderError("Claude output was cut off at the token limit")
        if response.parsed_output is None:
            raise ProviderError("Claude returned no structured output")
        log.debug(
            "llm_call",
            provider=self.name,
            model=self.model,
            cache_read=response.usage.cache_read_input_tokens,
            cache_write=response.usage.cache_creation_input_tokens,
        )
        return response.parsed_output
