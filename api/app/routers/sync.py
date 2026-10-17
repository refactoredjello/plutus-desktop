"""Manual sync trigger and run history."""

from fastapi import APIRouter, BackgroundTasks, Query, status
from sqlalchemy import select

from app import scheduler
from app.config import get_settings
from app.db import get_sessionmaker
from app.deps import AppSettings, DbSession
from app.errors import NotFoundError
from app.models import SyncRun
from app.models.base import SyncTrigger
from app.providers.bank.simplefin import PROVIDER_NAME
from app.schemas.sync import SyncRunRead, SyncSchedule
from app.services import sync as sync_service

router = APIRouter(prefix="/sync", tags=["sync"])


def _execute_in_background(run_id: int) -> None:
    """Runs after the response is sent, so it needs its own session."""
    settings = get_settings()
    with get_sessionmaker()() as db:
        run = db.get(SyncRun, run_id)
        if run is None:
            return
        try:
            provider = sync_service.build_provider(db, settings)
        except Exception as exc:
            sync_service.fail_run(db, run, str(exc))
            return
        sync_service.execute_run(db, settings, provider, run)


@router.post("", response_model=SyncRunRead, status_code=status.HTTP_202_ACCEPTED)
def start_sync(
    db: DbSession, settings: AppSettings, background_tasks: BackgroundTasks
) -> SyncRunRead:
    """Start a manual sync in the background. Poll the returned run for status."""
    if not sync_service.is_connected(db, settings):
        raise sync_service.NotConnectedError("SimpleFIN is not connected. Add a setup token first.")
    run = sync_service.start_run(db, settings, PROVIDER_NAME, SyncTrigger.MANUAL)
    background_tasks.add_task(_execute_in_background, run.id)
    return SyncRunRead.model_validate(run)


@router.get("/schedule", response_model=SyncSchedule)
def get_sync_schedule(settings: AppSettings) -> SyncSchedule:
    """When the next scheduled sync will run (before a few minutes of jitter)."""
    return SyncSchedule(
        enabled=settings.scheduler_enabled,
        interval_hours=settings.sync_interval_hours,
        next_run_at=scheduler.next_run_at(),
    )


@router.get("/runs", response_model=list[SyncRunRead])
def list_sync_runs(db: DbSession, limit: int = Query(20, ge=1, le=100)) -> list[SyncRunRead]:
    rows = db.scalars(
        select(SyncRun).order_by(SyncRun.started_at.desc(), SyncRun.id.desc()).limit(limit)
    )
    return [SyncRunRead.model_validate(r) for r in rows]


@router.get("/runs/{run_id}", response_model=SyncRunRead)
def get_sync_run(run_id: int, db: DbSession) -> SyncRunRead:
    run = db.get(SyncRun, run_id)
    if run is None:
        raise NotFoundError(f"Sync run {run_id} not found.")
    return SyncRunRead.model_validate(run)
