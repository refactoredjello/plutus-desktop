"""SimpleFIN connection owned by Wave 1 sync brief; LLM status by categorization brief."""

from datetime import UTC, datetime

from fastapi import APIRouter, status

from app.config import LLMProviderName
from app.deps import AppSettings, DbSession
from app.providers.bank import simplefin
from app.schemas.sync import LLMStatus, SimpleFINConnect, SimpleFINStatus
from app.services import app_settings

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("/simplefin", response_model=SimpleFINStatus)
def get_simplefin_status(db: DbSession, settings: AppSettings) -> SimpleFINStatus:
    connected = app_settings.get_setting(db, settings, app_settings.SIMPLEFIN_ACCESS_URL)
    stamp = app_settings.get_setting(db, settings, app_settings.SIMPLEFIN_CONNECTED_AT)
    return SimpleFINStatus(
        connected=connected is not None,
        connected_at=datetime.fromisoformat(stamp) if connected is not None and stamp else None,
    )


@router.post("/simplefin", response_model=SimpleFINStatus)
def connect_simplefin(
    body: SimpleFINConnect, db: DbSession, settings: AppSettings
) -> SimpleFINStatus:
    """Exchange a SimpleFIN setup token for an access URL and store it encrypted."""
    with simplefin.new_client() as client:
        access_url = simplefin.claim_setup_token(body.setup_token, client)
    now = datetime.now(UTC)
    app_settings.set_setting(
        db, settings, app_settings.SIMPLEFIN_ACCESS_URL, access_url, encrypt=True
    )
    app_settings.set_setting(db, settings, app_settings.SIMPLEFIN_CONNECTED_AT, now.isoformat())
    return SimpleFINStatus(connected=True, connected_at=now)


@router.delete("/simplefin", status_code=status.HTTP_204_NO_CONTENT)
def disconnect_simplefin(db: DbSession) -> None:
    app_settings.delete_setting(db, app_settings.SIMPLEFIN_ACCESS_URL)
    app_settings.delete_setting(db, app_settings.SIMPLEFIN_CONNECTED_AT)


@router.get("/llm", response_model=LLMStatus)
def get_llm_status(settings: AppSettings) -> LLMStatus:
    key = settings.anthropic_api_key
    configured = settings.llm_provider is not LLMProviderName.CLAUDE or (
        key is not None and bool(key.get_secret_value().strip())
    )
    return LLMStatus(
        provider=settings.llm_provider.value, model=settings.llm_model, configured=configured
    )
