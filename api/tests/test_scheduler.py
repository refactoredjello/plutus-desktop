from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app import scheduler

NOW = datetime(2026, 10, 3, 12, 0, tzinfo=UTC)
SIX_HOURS = timedelta(hours=6)


def test_first_run_keeps_cadence_after_restart() -> None:
    last = NOW - timedelta(hours=2)
    assert scheduler.first_run_at(last, SIX_HOURS, NOW) == last + SIX_HOURS


def test_first_run_soon_when_overdue_or_never_synced() -> None:
    assert scheduler.first_run_at(NOW - timedelta(hours=9), SIX_HOURS, NOW) == NOW + timedelta(
        minutes=2
    )
    assert scheduler.first_run_at(None, SIX_HOURS, NOW) == NOW + timedelta(minutes=2)


def test_schedule_endpoint(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(scheduler, "next_run_at", lambda: NOW + SIX_HOURS)
    body = client.get("/api/sync/schedule").json()
    assert body["interval_hours"] == 6
    assert body["next_run_at"].startswith("2026-10-03T18:00:00")
