"""Application settings. All configuration comes from the environment (twelve-factor)."""

from enum import StrEnum
from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Environment(StrEnum):
    DEVELOPMENT = "development"
    TEST = "test"
    PRODUCTION = "production"


class LLMProviderName(StrEnum):
    CLAUDE = "claude"
    OLLAMA = "ollama"
    FAKE = "fake"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: Environment = Environment.DEVELOPMENT
    database_url: str = "postgresql+psycopg://plutus:plutus@localhost:5432/plutus"
    secret_key: SecretStr = SecretStr("dev-only-change-me")
    app_password_hash: SecretStr | None = None
    cors_origins: list[str] = ["http://localhost:5173"]

    llm_provider: LLMProviderName = LLMProviderName.FAKE
    llm_model: str = "claude-haiku-4-5"
    anthropic_api_key: SecretStr | None = None
    ollama_base_url: str = "http://localhost:11434"

    sync_interval_hours: int = 6
    # How far back the very first sync reaches. Each 45 days costs one SimpleFIN request.
    sync_first_history_days: int = 180
    scheduler_enabled: bool = True
    owner_name_tokens: list[str] = []

    log_level: str = "info"

    @property
    def json_logs(self) -> bool:
        return self.environment is Environment.PRODUCTION


@lru_cache
def get_settings() -> Settings:
    return Settings()
