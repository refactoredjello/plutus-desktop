"""SimpleFIN sync (R1). One run = one pass over the provider; never retried within a run."""

from datetime import UTC, date, datetime, timedelta

import structlog
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.errors import ConflictError, DomainError
from app.models import Account, BalanceSnapshot, SyncRun, Transaction
from app.models.base import SyncStatus, SyncTrigger
from app.providers.bank import simplefin
from app.providers.bank.base import BankProvider, ProviderAccount, ProviderTransaction
from app.services import app_settings
from app.services import changes as changes_service
from app.services.categorize import categorize_pending
from app.services.recurring import detect_recurring
from app.services.transfers import match_transfers

log = structlog.get_logger()

OVERLAP_DAYS = 5
STALE_RUN_MINUTES = 30
DAILY_REQUEST_BUDGET = 24  # SimpleFIN: 24 requests per day


class NotConnectedError(DomainError):
    title = "SimpleFIN not connected"


def is_connected(db: Session, settings: Settings) -> bool:
    return app_settings.get_setting(db, settings, app_settings.SIMPLEFIN_ACCESS_URL) is not None


def build_provider(db: Session, settings: Settings) -> BankProvider:
    """Build the SimpleFIN provider from the stored (encrypted) access URL."""
    access_url = app_settings.get_setting(db, settings, app_settings.SIMPLEFIN_ACCESS_URL)
    if access_url is None:
        raise NotConnectedError("SimpleFIN is not connected. Add a setup token in Settings.")
    return simplefin.SimpleFINProvider(access_url)


def _recover_stale_runs(db: Session) -> None:
    """A run left `running` by a crash or restart would block every future sync."""
    now = datetime.now(UTC)
    stale = db.scalars(
        select(SyncRun).where(
            SyncRun.status == SyncStatus.RUNNING,
            SyncRun.started_at < now - timedelta(minutes=STALE_RUN_MINUTES),
        )
    ).all()
    for run in stale:
        run.status = SyncStatus.ERROR
        run.error_text = "Interrupted: the sync did not finish (the server may have restarted)."
        run.finished_at = now
        log.warning("sync_run_recovered", run_id=run.id)
    if stale:
        db.commit()


def requests_used_last_24h(db: Session, now: datetime) -> int:
    used = db.scalar(
        select(func.coalesce(func.sum(SyncRun.requests), 0)).where(
            SyncRun.started_at >= now - timedelta(hours=24)
        )
    )
    return int(used or 0)


def start_run(db: Session, settings: Settings, provider_name: str, trigger: SyncTrigger) -> SyncRun:
    """Apply the guards and commit a new `running` row."""
    _recover_stale_runs(db)
    changes_service.prune_dismissals(db)  # R12.6: housekeeping at the start of each run
    if db.scalar(select(SyncRun.id).where(SyncRun.status == SyncStatus.RUNNING).limit(1)):
        raise ConflictError("A sync is already running.")
    now = datetime.now(UTC)
    used = requests_used_last_24h(db, now)
    planned = len(simplefin.chunk_ranges(*_window(db, now, settings.sync_first_history_days)))
    if used + planned > DAILY_REQUEST_BUDGET:
        raise ConflictError(
            f"SimpleFIN daily request budget reached: {used} of {DAILY_REQUEST_BUDGET} used in the "
            f"last 24 hours and this sync needs {planned}. Try again later."
        )
    run = SyncRun(
        provider=provider_name, trigger=trigger, status=SyncStatus.RUNNING, started_at=now
    )
    db.add(run)
    db.commit()
    return run


def _window(db: Session, now: datetime, first_history_days: int) -> tuple[date, date]:
    last = db.scalar(
        select(SyncRun.started_at)
        .where(SyncRun.status == SyncStatus.SUCCESS)
        .order_by(SyncRun.started_at.desc())
        .limit(1)
    )
    start = (
        last - timedelta(days=OVERLAP_DAYS)
        if last is not None
        else now - timedelta(days=first_history_days)
    )
    return start.date(), now.date()


def _upsert_account(db: Session, provider_name: str, pa: ProviderAccount) -> Account:
    account = db.scalar(
        select(Account).where(
            Account.provider == provider_name, Account.external_id == pa.external_id
        )
    )
    if account is None:
        account = Account(provider=provider_name, external_id=pa.external_id)
        db.add(account)
    account.name = pa.name
    account.type = pa.type
    account.institution_name = pa.institution_name
    account.currency = pa.currency
    account.is_active = True
    db.flush()
    return account


def _apply(tx: Transaction, pt: ProviderTransaction) -> bool:
    """Copy provider fields onto a stored row. Returns True when anything changed."""
    values: dict[str, object] = {
        "transacted_at": pt.transacted_at,
        "amount": pt.amount,
        "raw_description": pt.description,
        "payee": pt.payee,
        "memo": pt.memo,
        "pending": pt.pending,
    }
    # A pending row without a transaction time has a made-up date; do not churn it every sync.
    if not (tx.pending and pt.pending and pt.transacted_at is None):
        values["posted_on"] = pt.posted_on
    changed = False
    for attr, new in values.items():
        if getattr(tx, attr) != new:
            setattr(tx, attr, new)
            changed = True
    return changed


def _upsert_transactions(
    db: Session, account: Account, transactions: list[ProviderTransaction]
) -> tuple[int, int]:
    if not transactions:
        return 0, 0
    ids = [t.external_id for t in transactions]
    existing = {
        t.external_id: t
        for t in db.scalars(
            select(Transaction).where(
                Transaction.account_id == account.id, Transaction.external_id.in_(ids)
            )
        )
    }
    added = updated = 0
    for pt in transactions:
        tx = existing.get(pt.external_id)
        if tx is None:
            tx = Transaction(account_id=account.id, external_id=pt.external_id)
            _apply(tx, pt)
            tx.posted_on = pt.posted_on
            db.add(tx)
            added += 1
        elif _apply(tx, pt):
            updated += 1
    return added, updated


def _drop_stale_pending(db: Session, account: Account, start: date, seen: set[str]) -> None:
    """A pending row that was not returned again either posted under a new id or was dropped."""
    stmt = delete(Transaction).where(
        Transaction.account_id == account.id,
        Transaction.pending.is_(True),
        Transaction.posted_on >= start,
    )
    if seen:
        stmt = stmt.where(Transaction.external_id.not_in(seen))
    db.execute(stmt)


def execute_run(db: Session, settings: Settings, provider: BankProvider, run: SyncRun) -> SyncRun:
    """Run the sync for an existing `running` row, then record the outcome."""
    run_id = run.id
    try:
        start, end = _window(db, run.started_at, settings.sync_first_history_days)
        snapshot = provider.fetch(start, end)
        added = updated = 0
        for pa in snapshot.accounts:
            account = _upsert_account(db, provider.name, pa)
            db.add(
                BalanceSnapshot(
                    account_id=account.id,
                    balance=pa.balance,
                    available=pa.available,
                    as_of=pa.balance_as_of,
                )
            )
            a, u = _upsert_transactions(db, account, pa.transactions)
            added += a
            updated += u
            if not snapshot.errors:  # partial data must not delete rows we simply did not see
                _drop_stale_pending(db, account, start, {t.external_id for t in pa.transactions})
        db.flush()
        match_transfers(db)
        categorize_pending(db, settings)
        detect_recurring(db)
        run = db.get(SyncRun, run_id) or run
        run.added = added
        run.requests = getattr(provider, "requests_made", 0)
        run.updated = updated
        if snapshot.errors:
            run.status = SyncStatus.ERROR
            run.error_text = "; ".join(snapshot.errors)
        else:
            run.status = SyncStatus.SUCCESS
        run.finished_at = datetime.now(UTC)
        db.commit()
    except Exception as exc:
        db.rollback()
        log.exception("sync_run_failed", run_id=run_id)
        failed = db.get(SyncRun, run_id) or run
        failed.requests = getattr(provider, "requests_made", 0)  # failed runs still spend budget
        run = fail_run(db, failed, exc.detail if isinstance(exc, DomainError) else repr(exc))
    return run


def fail_run(db: Session, run: SyncRun, message: str) -> SyncRun:
    run.status = SyncStatus.ERROR
    run.error_text = message[:2000]
    run.finished_at = datetime.now(UTC)
    db.commit()
    return run


def run_sync(
    db: Session, settings: Settings, provider: BankProvider, trigger: SyncTrigger
) -> SyncRun:
    run = start_run(db, settings, provider.name, trigger)
    return execute_run(db, settings, provider, run)
