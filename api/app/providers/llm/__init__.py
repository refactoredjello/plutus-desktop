"""Provider factory for the LLM boundary."""

from app.config import LLMProviderName, Settings
from app.errors import ProviderError
from app.providers.llm.base import LLMProvider
from app.providers.llm.claude import ClaudeProvider
from app.providers.llm.fake import FakeLLMProvider
from app.providers.llm.ollama import OllamaProvider


def get_llm_provider(settings: Settings) -> LLMProvider:
    match settings.llm_provider:
        case LLMProviderName.FAKE:
            return FakeLLMProvider()
        case LLMProviderName.CLAUDE:
            key = settings.anthropic_api_key
            if key is None or not key.get_secret_value().strip():
                raise ProviderError("LLM_PROVIDER=claude requires ANTHROPIC_API_KEY to be set")
            return ClaudeProvider(key.get_secret_value(), settings.llm_model)
        case LLMProviderName.OLLAMA:
            return OllamaProvider(settings.ollama_base_url, settings.llm_model)
