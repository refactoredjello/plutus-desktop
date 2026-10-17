from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, SyncStatus, SyncTrigger, str_enum


class SyncRun(Base):
    __tablename__ = "sync_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(20))
    trigger: Mapped[SyncTrigger] = mapped_column(str_enum(SyncTrigger))
    status: Mapped[SyncStatus] = mapped_column(str_enum(SyncStatus), default=SyncStatus.RUNNING)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    added: Mapped[int] = mapped_column(default=0)
    updated: Mapped[int] = mapped_column(default=0)
    error_text: Mapped[str | None] = mapped_column(Text)
    # Provider HTTP requests this run made; the daily budget guard sums these.
    requests: Mapped[int] = mapped_column(default=0, server_default="0")


class AppSetting(Base):
    """Key/value store. Encrypted values (e.g. the SimpleFIN access URL) use Fernet."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    is_encrypted: Mapped[bool] = mapped_column(default=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ChangeDismissal(Base):
    """A dismissed "What changed" item (R12.6). Keyed by the fact, so a new fact reappears."""

    __tablename__ = "change_dismissals"

    key: Mapped[str] = mapped_column(String(255), primary_key=True)
    signal: Mapped[str] = mapped_column(String(10))
    dismissed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
