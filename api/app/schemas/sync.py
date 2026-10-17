from datetime import datetime

from pydantic import BaseModel, Field

from app.models.base import SyncStatus, SyncTrigger
from app.schemas.common import ReadSchema, Schema


class SyncRunRead(ReadSchema):
    id: int
    provider: str
    trigger: SyncTrigger
    status: SyncStatus
    started_at: datetime
    finished_at: datetime | None
    added: int
    updated: int
    error_text: str | None
    requests: int


class SyncSchedule(BaseModel):
    enabled: bool
    interval_hours: int
    next_run_at: datetime | None


class SimpleFINConnect(Schema):
    setup_token: str = Field(min_length=1)


class SimpleFINStatus(BaseModel):
    connected: bool
    connected_at: datetime | None


class LLMStatus(BaseModel):
    provider: str
    model: str
    configured: bool
