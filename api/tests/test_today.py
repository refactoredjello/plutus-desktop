"""schedule.today() honours PLUTUS_TODAY, so the parity harness can pin "today" in both apps."""

from datetime import UTC, date, datetime

import pytest

from app.services import schedule


def test_today_is_the_utc_date_without_plutus_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PLUTUS_TODAY", raising=False)
    before = datetime.now(UTC).date()
    result = schedule.today()
    assert before <= result <= datetime.now(UTC).date()


def test_today_returns_plutus_today_when_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PLUTUS_TODAY", "2026-09-30")
    assert schedule.today() == date(2026, 9, 30)


def test_plutus_today_is_read_at_call_time(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PLUTUS_TODAY", "2024-02-29")
    assert schedule.today() == date(2024, 2, 29)
    monkeypatch.setenv("PLUTUS_TODAY", "2025-01-01")
    assert schedule.today() == date(2025, 1, 1)


def test_empty_plutus_today_falls_back_to_the_utc_date(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PLUTUS_TODAY", "")
    assert schedule.today() == datetime.now(UTC).date()


def test_invalid_plutus_today_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PLUTUS_TODAY", "2026-02-30")
    with pytest.raises(ValueError, match="must be in range"):
        schedule.today()
