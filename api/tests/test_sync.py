from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.config import Settings
from app.errors import ConflictError
from app.models import Account, AppSetting, BalanceSnapshot, SyncRun, Transaction
from app.models.base import AccountType, SyncStatus, SyncTrigger
from app.providers.bank.base import ProviderAccount, ProviderSnapshot, ProviderTransaction
from app.providers.bank.simplefin import SimpleFINProvider
from app.services import app_settings, sync
from tests.simplefin_helpers import ACCESS_URL, mock_client


@pytest.fixture
def settings() -> Settings:
    return Settings(secret_key="test-secret")  # type: ignore[arg-type]


class FakeProvider:
    name = "simplefin"

    def __init__(self, *snapshots: ProviderSnapshot) -> None:
        self.snapshots = list(snapshots)
        self.windows: list[tuple[date, date]] = []

    def fetch(self, start: date, end: date) -> ProviderSnapshot:
        self.windows.append((start, end))
        return self.snapshots.pop(0)


def tx(
    ext: str,
    *,
    pending: bool = False,
    amount: str = "-5.00",
    day: int = 1,
    posted_on: date | None = None,
) -> ProviderTransaction:
    posted = posted_on or date(2026, 10, day)
    return ProviderTransaction(
        external_id=ext,
        posted_on=posted,
        amount=Decimal(amount),
        description="COFFEE",
        pending=pending,
        transacted_at=datetime.combine(posted, datetime.min.time(), tzinfo=UTC)
        if pending
        else None,
    )


def snap(*txs: ProviderTransaction, errors: list[str] | None = None) -> ProviderSnapshot:
    acct = ProviderAccount(
        external_id="A1",
        name="Checking",
        type=AccountType.CHECKING,
        institution_name="Bank",
        currency="USD",
        balance=Decimal("100.00"),
        available=None,
        balance_as_of=datetime(2026, 10, 3, tzinfo=UTC),
        transactions=list(txs),
    )
    return ProviderSnapshot(accounts=[acct], errors=errors or [])


def test_first_and_second_sync_with_fixture(db: Session, settings: Settings) -> None:
    provider = SimpleFINProvider(ACCESS_URL, mock_client())
    run1 = sync.run_sync(db, settings, provider, SyncTrigger.MANUAL)
    assert run1.status is SyncStatus.SUCCESS
    assert run1.added == 295
    assert run1.updated == 0
    assert run1.finished_at is not None
    assert db.scalar(select(func.count()).select_from(Account)) == 3
    assert db.scalar(select(func.count()).select_from(Transaction)) == 295
    assert db.scalar(select(func.count()).select_from(BalanceSnapshot)) == 3

    run2 = sync.run_sync(db, settings, provider, SyncTrigger.SCHEDULED)
    assert run2.status is SyncStatus.SUCCESS
    assert run2.added == 0
    assert run2.updated == 0
    assert db.scalar(select(func.count()).select_from(Transaction)) == 295
    assert db.scalar(select(func.count()).select_from(BalanceSnapshot)) == 6


def test_window_first_run_and_overlap(db: Session, settings: Settings) -> None:
    provider = FakeProvider(snap(), snap())
    first = sync.run_sync(db, settings, provider, SyncTrigger.MANUAL)
    start, end = provider.windows[0]
    assert (end - start).days == settings.sync_first_history_days == 180
    sync.run_sync(db, settings, provider, SyncTrigger.MANUAL)
    start2, _ = provider.windows[1]
    assert start2 == (first.started_at - timedelta(days=5)).date()


def test_changed_field_counts_as_update(db: Session, settings: Settings) -> None:
    provider = FakeProvider(snap(tx("T1")), snap(tx("T1", amount="-6.00")))
    sync.run_sync(db, settings, provider, SyncTrigger.MANUAL)
    run = sync.run_sync(db, settings, provider, SyncTrigger.MANUAL)
    assert (run.added, run.updated) == (0, 1)


def test_pending_posts_in_place_and_with_new_id(db: Session, settings: Settings) -> None:
    # Posted today: a stale pending row is only dropped inside the second run's overlap window.
    today = datetime.now(UTC).date()
    provider = FakeProvider(
        snap(tx("P1", pending=True, posted_on=today), tx("P2", pending=True, posted_on=today)),
        # P1 posts under the same id; P2 posts under a new id
        snap(tx("P1", posted_on=today), tx("POSTED2", posted_on=today)),
    )
    sync.run_sync(db, settings, provider, SyncTrigger.MANUAL)
    run = sync.run_sync(db, settings, provider, SyncTrigger.MANUAL)
    rows = {t.external_id: t for t in db.scalars(select(Transaction))}
    assert set(rows) == {"P1", "POSTED2"}
    assert not any(t.pending for t in rows.values())
    assert (run.added, run.updated) == (1, 1)


def test_provider_errors_mark_run_error_and_keep_pending(db: Session, settings: Settings) -> None:
    provider = FakeProvider(snap(tx("P1", pending=True)), snap(errors=["Bank needs attention"]))
    sync.run_sync(db, settings, provider, SyncTrigger.MANUAL)
    run = sync.run_sync(db, settings, provider, SyncTrigger.MANUAL)
    assert run.status is SyncStatus.ERROR
    assert run.error_text
    assert "Bank needs attention" in run.error_text
    assert db.scalar(select(func.count()).select_from(Transaction)) == 1


def test_provider_exception_marks_run_error(db: Session, settings: Settings) -> None:
    class Boom:
        name = "simplefin"

        def fetch(self, start: date, end: date) -> ProviderSnapshot:
            raise RuntimeError("kaput")

    run = sync.run_sync(db, settings, Boom(), SyncTrigger.MANUAL)
    assert run.status is SyncStatus.ERROR
    assert run.error_text
    assert "kaput" in run.error_text
    assert run.finished_at is not None


def test_guard_refuses_concurrent_run(db: Session, settings: Settings) -> None:
    sync.start_run(db, settings, "simplefin", SyncTrigger.MANUAL)
    with pytest.raises(ConflictError, match="already running"):
        sync.run_sync(db, settings, FakeProvider(snap()), SyncTrigger.MANUAL)


def test_guard_refuses_over_daily_budget(db: Session, settings: Settings) -> None:
    now = datetime.now(UTC)
    db.add(
        SyncRun(
            provider="simplefin",
            trigger=SyncTrigger.SCHEDULED,
            status=SyncStatus.SUCCESS,
            started_at=now - timedelta(minutes=5),
            requests=sync.DAILY_REQUEST_BUDGET - 1,  # 23 used; a 1-request incremental sync fits
        )
    )
    db.commit()
    run = sync.run_sync(db, settings, FakeProvider(snap()), SyncTrigger.MANUAL)
    assert run.status is SyncStatus.SUCCESS
    db.add(
        SyncRun(
            provider="simplefin",
            trigger=SyncTrigger.SCHEDULED,
            status=SyncStatus.SUCCESS,
            started_at=now - timedelta(minutes=1),
            requests=1,
        )
    )
    db.commit()
    with pytest.raises(ConflictError, match="budget"):
        sync.run_sync(db, settings, FakeProvider(snap()), SyncTrigger.MANUAL)


def test_old_runs_do_not_count_toward_budget(db: Session, settings: Settings) -> None:
    old = datetime.now(UTC) - timedelta(hours=30)
    for _ in range(25):
        db.add(
            SyncRun(
                provider="simplefin",
                trigger=SyncTrigger.SCHEDULED,
                status=SyncStatus.SUCCESS,
                started_at=old,
            )
        )
    db.commit()
    run = sync.run_sync(db, settings, FakeProvider(snap()), SyncTrigger.MANUAL)
    assert run.status is SyncStatus.SUCCESS


def test_encryption_round_trip_and_not_plaintext(db: Session, settings: Settings) -> None:
    app_settings.set_setting(
        db, settings, app_settings.SIMPLEFIN_ACCESS_URL, ACCESS_URL, encrypt=True
    )
    row = db.get(AppSetting, app_settings.SIMPLEFIN_ACCESS_URL)
    assert row is not None
    assert row.is_encrypted
    assert "pass456" not in row.value
    assert "bridge.example" not in row.value
    raw = db.execute(text("select value from app_settings")).scalar_one()
    assert "pass456" not in raw
    assert app_settings.get_setting(db, settings, app_settings.SIMPLEFIN_ACCESS_URL) == ACCESS_URL
    app_settings.delete_setting(db, app_settings.SIMPLEFIN_ACCESS_URL)
    assert app_settings.get_setting(db, settings, app_settings.SIMPLEFIN_ACCESS_URL) is None


def test_build_provider_requires_connection(db: Session, settings: Settings) -> None:
    with pytest.raises(sync.NotConnectedError):
        sync.build_provider(db, settings)
    app_settings.set_setting(
        db, settings, app_settings.SIMPLEFIN_ACCESS_URL, ACCESS_URL, encrypt=True
    )
    assert sync.build_provider(db, settings).name == "simplefin"


def test_stale_running_run_is_recovered(db: Session, settings: Settings) -> None:
    stale = SyncRun(
        provider="simplefin",
        trigger=SyncTrigger.SCHEDULED,
        status=SyncStatus.RUNNING,
        started_at=datetime.now(UTC) - timedelta(minutes=sync.STALE_RUN_MINUTES + 5),
    )
    db.add(stale)
    db.commit()
    run = sync.run_sync(db, settings, FakeProvider(snap()), SyncTrigger.MANUAL)
    assert run.status is SyncStatus.SUCCESS
    db.refresh(stale)
    assert stale.status is SyncStatus.ERROR
    assert stale.finished_at is not None
    assert stale.error_text is not None
    assert stale.error_text.startswith("Interrupted")


def test_fresh_running_run_still_blocks(db: Session, settings: Settings) -> None:
    db.add(
        SyncRun(
            provider="simplefin",
            trigger=SyncTrigger.SCHEDULED,
            status=SyncStatus.RUNNING,
            started_at=datetime.now(UTC) - timedelta(minutes=1),
        )
    )
    db.commit()
    with pytest.raises(ConflictError, match="already running"):
        sync.run_sync(db, settings, FakeProvider(snap()), SyncTrigger.MANUAL)
