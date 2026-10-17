import csv
import json
from decimal import Decimal
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import anthropic
import httpx
import pytest

from app.config import LLMProviderName, Settings
from app.errors import ProviderError
from app.models.base import Confidence, Essentiality
from app.providers.llm import get_llm_provider
from app.providers.llm.base import (
    CategorySpend,
    MerchantInput,
    RecurringSpend,
    SavingsContext,
)
from app.providers.llm.claude import ClaudeProvider
from app.providers.llm.fake import FakeLLMProvider
from app.providers.llm.ollama import OllamaProvider
from app.providers.llm.prompts import (
    SEED,
    ClassificationBatch,
    ClassifiedMerchant,
    SuggestedSaving,
    SuggestionBatch,
    classify_system_prompt,
    classify_user_message,
    taxonomy_text,
)

ITEMS = [
    MerchantInput("BLUE BOTTLE COFFEE OAKLAND CA", "<10", "outflow", "credit"),
    MerchantInput("ACME CORP PAYROLL", ">1000", "inflow", "checking"),
]
RESULT = ClassificationBatch(
    items=[
        ClassifiedMerchant(
            merchant_key="BLUE BOTTLE COFFEE OAKLAND CA",
            detailed_category="FOOD_AND_DRINK_COFFEE",
            essentiality=Essentiality.DISCRETIONARY,
            confidence=Confidence.HIGH,
        ),
        ClassifiedMerchant(
            merchant_key="ACME CORP PAYROLL",
            detailed_category="INCOME_SALARY",
            essentiality=Essentiality.ESSENTIAL,
            confidence=Confidence.VERY_HIGH,
        ),
    ]
)
CONTEXT = SavingsContext(
    goal_target=Decimal("5000.00"),
    months_left=6,
    monthly_gap=Decimal("300.00"),
    categories=[CategorySpend("Restaurants", [Decimal("200.00"), Decimal("250.50")])],
    recurring=[
        RecurringSpend("TV and movies", Decimal("15.49"), "monthly", Essentiality.DISCRETIONARY)
    ],
    excluded_suggestions=["Cancel Netflix"],
)


def _response(parsed: Any, stop_reason: str = "end_turn") -> SimpleNamespace:
    usage = SimpleNamespace(cache_read_input_tokens=0, cache_creation_input_tokens=0)
    return SimpleNamespace(parsed_output=parsed, stop_reason=stop_reason, usage=usage)


def _claude(
    response: Any = None, error: Exception | None = None
) -> tuple[ClaudeProvider, MagicMock]:
    client = MagicMock()
    if error:
        client.messages.parse.side_effect = error
    else:
        client.messages.parse.return_value = response if response is not None else _response(RESULT)
    return ClaudeProvider("sk-test", "claude-haiku-4-5", client=client), client


# --- system prompt ----------------------------------------------------------------------------


def test_system_prompt_lists_full_taxonomy_and_is_large_enough_to_cache() -> None:
    prompt = classify_system_prompt()
    with SEED.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 127
    for row in rows:
        assert f"- {row['detailed']} |" in prompt
    for label in ("essential", "flexible", "discretionary"):
        assert label in prompt
    # Haiku 4.5 caches prefixes of 4096+ tokens; ~3.5 characters per token is conservative here.
    assert len(prompt) / 3.5 > 4096
    assert prompt == classify_system_prompt()


def test_taxonomy_is_sorted() -> None:
    lines = taxonomy_text().splitlines()
    names = [ln.split(" | ")[0] for ln in lines]
    assert len(names) == 127
    assert names == sorted(names, key=lambda n: n)  # primary groups sort with their names


def test_user_message_has_no_four_digit_runs() -> None:
    import re

    assert not re.search(r"\d{4,}", classify_user_message(ITEMS))


# --- Claude -----------------------------------------------------------------------------------


def test_claude_request_shape() -> None:
    provider, client = _claude()
    out = provider.classify_merchants(ITEMS)

    kwargs = client.messages.parse.call_args.kwargs
    assert kwargs["model"] == "claude-haiku-4-5"
    assert kwargs["output_format"] is ClassificationBatch
    assert "thinking" not in kwargs
    system = kwargs["system"]
    assert system[0]["text"] == classify_system_prompt()
    assert system[0]["cache_control"] == {"type": "ephemeral"}
    user = kwargs["messages"][0]["content"]
    assert "BLUE BOTTLE COFFEE OAKLAND CA" in user
    assert "outflow" in user

    assert [c.merchant_key for c in out] == [i.merchant_key for i in ITEMS]
    assert out[0].detailed_category == "FOOD_AND_DRINK_COFFEE"
    assert out[0].essentiality is Essentiality.DISCRETIONARY
    assert out[1].confidence is Confidence.VERY_HIGH


def test_claude_system_prompt_is_identical_across_calls() -> None:
    provider, client = _claude()
    provider.classify_merchants(ITEMS)
    provider.classify_merchants(ITEMS[:1])
    first, second = (c.kwargs for c in client.messages.parse.call_args_list)
    assert first["system"] == second["system"]
    assert first["messages"] != second["messages"]


def test_claude_empty_batch_makes_no_call() -> None:
    provider, client = _claude()
    assert provider.classify_merchants([]) == []
    client.messages.parse.assert_not_called()


@pytest.mark.parametrize("stop_reason", ["refusal", "max_tokens"])
def test_claude_bad_stop_reasons_raise_provider_error(stop_reason: str) -> None:
    provider, _ = _claude(_response(RESULT, stop_reason))
    with pytest.raises(ProviderError):
        provider.classify_merchants(ITEMS)


def test_claude_missing_parsed_output_raises_provider_error() -> None:
    provider, _ = _claude(_response(None))
    with pytest.raises(ProviderError):
        provider.classify_merchants(ITEMS)


_REQUEST = httpx.Request("POST", "https://api.anthropic.com/v1/messages")


def _status_response(code: int) -> httpx.Response:
    return httpx.Response(code, request=_REQUEST, json={"error": {"message": "x"}})


@pytest.mark.parametrize(
    "error",
    [
        anthropic.RateLimitError("slow down", response=_status_response(429), body=None),
        anthropic.InternalServerError("oops", response=_status_response(500), body=None),
        anthropic.AuthenticationError("bad key", response=_status_response(401), body=None),
        anthropic.APIConnectionError(request=_REQUEST),
        anthropic.APITimeoutError(request=_REQUEST),
    ],
    ids=lambda e: type(e).__name__,
)
def test_claude_sdk_errors_become_provider_errors(error: Exception) -> None:
    provider, _ = _claude(error=error)
    with pytest.raises(ProviderError):
        provider.classify_merchants(ITEMS)
    with pytest.raises(ProviderError):
        provider.suggest_savings(CONTEXT)


def test_claude_suggest_savings() -> None:
    parsed = SuggestionBatch(
        suggestions=[
            SuggestedSaving(
                text="Cook at home twice a week.",
                category_label="Restaurants",
                estimated_monthly_saving=40.5,
            ),
            SuggestedSaving(
                text="Review subscriptions.", category_label=None, estimated_monthly_saving=None
            ),
        ]
    )
    provider, client = _claude(_response(parsed))
    out = provider.suggest_savings(CONTEXT)

    kwargs = client.messages.parse.call_args.kwargs
    assert kwargs["output_format"] is SuggestionBatch
    assert kwargs["system"][0]["cache_control"] == {"type": "ephemeral"}
    user = kwargs["messages"][0]["content"]
    payload = json.loads(user.split("\n", 1)[1])
    assert payload["excluded_suggestions"] == ["Cancel Netflix"]
    assert payload["monthly_gap"] == "300.00"
    assert payload["categories"][0] == {
        "label": "Restaurants",
        "monthly_totals": ["200.00", "250.50"],
    }
    assert "merchant" not in user.lower()
    assert out[0].estimated_monthly_saving == Decimal("40.50")
    assert out[1].estimated_monthly_saving is None

    # Savings prompt is also stable across calls.
    provider.suggest_savings(CONTEXT)
    a, b = (c.kwargs["system"] for c in client.messages.parse.call_args_list)
    assert a == b


# --- Ollama -----------------------------------------------------------------------------------


def _ollama(handler: Any) -> OllamaProvider:
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return OllamaProvider("http://ollama.test:11434/", "llama3.1", client=client)


def test_ollama_request_and_parsing() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200, json={"message": {"role": "assistant", "content": RESULT.model_dump_json()}}
        )

    out = _ollama(handler).classify_merchants(ITEMS)
    request = seen[0]
    assert str(request.url) == "http://ollama.test:11434/api/chat"
    body = json.loads(request.content)
    assert body["model"] == "llama3.1"
    assert body["stream"] is False
    assert body["format"] == ClassificationBatch.model_json_schema()
    assert body["messages"][0] == {"role": "system", "content": classify_system_prompt()}
    assert "ACME CORP PAYROLL" in body["messages"][1]["content"]
    assert [c.detailed_category for c in out] == ["FOOD_AND_DRINK_COFFEE", "INCOME_SALARY"]


def test_ollama_suggest_savings() -> None:
    content = SuggestionBatch(
        suggestions=[
            SuggestedSaving(text="Trim dining.", category_label=None, estimated_monthly_saving=20)
        ]
    ).model_dump_json()

    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["format"] == SuggestionBatch.model_json_schema()
        return httpx.Response(200, json={"message": {"content": content}})

    assert _ollama(handler).suggest_savings(CONTEXT)[0].estimated_monthly_saving == Decimal("20")


@pytest.mark.parametrize(
    "handler",
    [
        lambda r: httpx.Response(500, text="boom"),
        lambda r: httpx.Response(200, text="not json"),
        lambda r: httpx.Response(200, json={"message": {"content": "{}"}}),
        lambda r: httpx.Response(
            200, json={"message": {"content": '{"items": [{"merchant_key": "X"}]}'}}
        ),
        lambda r: httpx.Response(200, json={"unexpected": True}),
    ],
)
def test_ollama_bad_responses_raise_provider_error(handler: Any) -> None:
    with pytest.raises(ProviderError):
        _ollama(handler).classify_merchants(ITEMS)


def test_ollama_connection_error_raises_provider_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(ProviderError):
        _ollama(handler).classify_merchants(ITEMS)


# --- factory ----------------------------------------------------------------------------------


def test_factory_returns_each_provider() -> None:
    assert isinstance(
        get_llm_provider(Settings(llm_provider=LLMProviderName.FAKE)), FakeLLMProvider
    )
    claude = get_llm_provider(
        Settings(llm_provider=LLMProviderName.CLAUDE, anthropic_api_key="sk-test")  # type: ignore[arg-type]
    )
    assert isinstance(claude, ClaudeProvider)
    assert claude.model == "claude-haiku-4-5"
    ollama = get_llm_provider(Settings(llm_provider=LLMProviderName.OLLAMA, llm_model="llama3.1"))
    assert isinstance(ollama, OllamaProvider)


def test_factory_requires_api_key_for_claude() -> None:
    with pytest.raises(ProviderError, match="ANTHROPIC_API_KEY"):
        get_llm_provider(Settings(llm_provider=LLMProviderName.CLAUDE, anthropic_api_key=None))


def test_default_model_has_no_date_suffix() -> None:
    assert Settings().llm_model == "claude-haiku-4-5"
