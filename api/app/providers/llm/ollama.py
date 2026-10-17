"""Ollama implementation of LLMProvider over its HTTP chat API (no extra dependency)."""

import httpx
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

TIMEOUT_SECONDS = 300.0  # local models can be slow on a cold start


class OllamaProvider:
    name = "ollama"

    def __init__(
        self,
        base_url: str,
        model: str,
        client: httpx.Client | None = None,
    ) -> None:
        self.model = model
        self._url = base_url.rstrip("/") + "/api/chat"
        self._client = client or httpx.Client(timeout=TIMEOUT_SECONDS)

    def classify_merchants(self, items: list[MerchantInput]) -> list[MerchantClassification]:
        if not items:
            return []
        batch = self._chat(
            classify_system_prompt(), classify_user_message(items), ClassificationBatch
        )
        return to_classifications(batch)

    def suggest_savings(self, context: SavingsContext) -> list[SavingsSuggestion]:
        batch = self._chat(savings_system_prompt(), savings_user_message(context), SuggestionBatch)
        return to_suggestions(batch)

    def _chat[M: BaseModel](self, system: str, user: str, output_format: type[M]) -> M:
        body = {
            "model": self.model,
            "stream": False,
            "format": output_format.model_json_schema(),
            "options": {"temperature": 0},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        try:
            response = self._client.post(self._url, json=body)
            response.raise_for_status()
            content = response.json()["message"]["content"]
            return output_format.model_validate_json(content)
        except httpx.HTTPStatusError as exc:
            raise ProviderError(f"Ollama returned status {exc.response.status_code}") from exc
        except httpx.HTTPError as exc:
            raise ProviderError("Could not reach Ollama") from exc
        except (ValueError, KeyError, TypeError, ValidationError) as exc:
            raise ProviderError("Ollama returned an unusable response") from exc
