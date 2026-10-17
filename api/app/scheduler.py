"""Background scheduler: one periodic sync job."""

from datetime import UTC, datetime, timedelta

import structlog
from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import func, select

from app.config import Settings
from app.db import get_sessionmaker
from app.errors import DomainError
from app.models import SyncRun
from app.models.base import SyncTrigger
from app.services import sync as sync_service

log = structlog.get_logger()

JOB_ID = "simplefin_sync"
JITTER_SECONDS = 120
OVERDUE_DELAY = timedelta(minutes=2)

_scheduler: BackgroundScheduler | None = None


def run_scheduled_sync(settings: Settings) -> None:
    """Job body. Skips quietly when SimpleFIN is not connected or a guard refuses."""
    with get_sessionmaker()() as db:
        try:
            if not sync_service.is_connected(db, settings):
                log.info("scheduled_sync_skipped", reason="not_connected")
                return
            provider = sync_service.build_provider(db, settings)
            run = sync_service.run_sync(db, settings, provider, SyncTrigger.SCHEDULED)
            log.info("scheduled_sync_finished", run_id=run.id, status=str(run.status))
        except DomainError as exc:
            log.warning("scheduled_sync_skipped", reason=exc.detail)
        except Exception:
            log.exception("scheduled_sync_crashed")


def first_run_at(last_started: datetime | None, interval: timedelta, now: datetime) -> datetime:
    """Keep the cadence across restarts: one interval after the last sync, or soon if overdue."""
    due = last_started + interval if last_started is not None else now
    return max(due, now + OVERDUE_DELAY)


def _last_sync_started() -> datetime | None:
    try:
        with get_sessionmaker()() as db:
            return db.scalar(select(func.max(SyncRun.started_at)))
    except Exception:  # database not ready yet; fall back to "soon"
        log.warning("scheduler_last_sync_unknown")
        return None


def next_run_at() -> datetime | None:
    """When the periodic sync will next fire, or None when the scheduler is off."""
    if _scheduler is None:
        return None
    job = _scheduler.get_job(JOB_ID)
    return job.next_run_time if job is not None else None


def start_scheduler(settings: Settings) -> None:
    """Start APScheduler with the periodic sync job."""
    global _scheduler
    if _scheduler is not None:
        return
    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(
        run_scheduled_sync,
        "interval",
        hours=settings.sync_interval_hours,
        jitter=JITTER_SECONDS,
        args=[settings],
        id=JOB_ID,
        max_instances=1,
        coalesce=True,
        replace_existing=True,
        next_run_time=first_run_at(
            _last_sync_started(),
            timedelta(hours=settings.sync_interval_hours),
            datetime.now(UTC),
        ),
    )
    scheduler.start()
    _scheduler = scheduler


def stop_scheduler() -> None:
    """Stop the scheduler gracefully."""
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
