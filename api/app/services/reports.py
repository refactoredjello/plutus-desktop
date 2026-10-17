"""Report data for the dashboard (R4)."""

from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.errors import DomainError
from app.models import Account, BalanceSnapshot, Transaction
from app.models.base import EssentialityFilter
from app.schemas.month import EssentialityShare, MonthCategory, MonthDetail
from app.schemas.reports import (
    AccountBalanceSeries,
    BalancePoint,
    CategoryTotal,
    MonthlySummary,
)
from app.schemas.transactions import TransactionRead
from app.services import schedule
from app.services import transactions as transactions_service
from app.services.aggregates import (
    ZERO,
    category_totals,
    largest_expense_ids,
    month_bounds,
    month_key,
    month_range,
    monthly_totals,
    recent_active_months,
)

DEFAULT_HISTORY_DAYS = 180


def monthly_summary(db: Session, months: int) -> list[MonthlySummary]:
    return [
        MonthlySummary(
            month=t.month,
            income=t.income,
            expenses=t.expenses,
            net=t.net,
            essential=t.essential,
            flexible=t.flexible,
            discretionary=t.discretionary,
            uncategorized=t.uncategorized,
        )
        for t in monthly_totals(db, month_range(schedule.today(), months))
    ]


def spending_by_category(
    db: Session, month: str, essentiality: EssentialityFilter | None = None
) -> list[CategoryTotal]:
    if not 1 <= int(month[5:7]) <= 12:
        raise DomainError(f"Invalid month {month!r}")
    return [
        CategoryTotal(
            category_id=c.category_id,
            label=c.label,
            primary=c.primary,
            total=c.total,
            count=c.count,
        )
        for c in category_totals(db, [month], essentiality)
    ]


def balance_history(
    db: Session, start: date | None = None, end: date | None = None
) -> list[AccountBalanceSeries]:
    """Daily balance per active account, rebuilt backwards from its latest snapshot.

    Snapshots are sparse (one per sync), so for a snapshot balance B on day D:
    balance(d) = B - sum(amounts posted in (d, D]); days after D carry B.
    """
    end = end or schedule.today()
    start = start or end - timedelta(days=DEFAULT_HISTORY_DAYS)
    if start > end:
        return []
    accounts = db.scalars(
        select(Account).where(Account.is_active.is_(True)).order_by(Account.id)
    ).all()
    out: list[AccountBalanceSeries] = []
    for account in accounts:
        snap = db.scalars(
            select(BalanceSnapshot)
            .where(BalanceSnapshot.account_id == account.id)
            .order_by(BalanceSnapshot.as_of.desc(), BalanceSnapshot.id.desc())
            .limit(1)
        ).first()
        if snap is None:
            continue
        snap_day = snap.as_of.date()
        daily: dict[date, Decimal] = defaultdict(lambda: Decimal(0))
        for posted_on, total in db.execute(
            select(Transaction.posted_on, func.sum(Transaction.amount))
            .where(
                Transaction.account_id == account.id,
                Transaction.posted_on > start,
                Transaction.posted_on <= snap_day,
            )
            .group_by(Transaction.posted_on)
        ):
            daily[posted_on] = Decimal(total)
        after = sum((v for k, v in daily.items() if k > end), Decimal(0))
        points: list[BalancePoint] = []
        day = end
        while day >= start:
            points.append(BalancePoint(on=day, balance=snap.balance - after))
            after += daily.get(day, Decimal(0))
            day -= timedelta(days=1)
        points.reverse()
        out.append(AccountBalanceSeries(account_id=account.id, name=account.name, points=points))
    return out


def _rate(net: Decimal, income: Decimal) -> float | None:
    return round(float(net / income), 4) if income > 0 else None


def month_detail(db: Session, month: str) -> MonthDetail:
    if not 1 <= int(month[5:7]) <= 12:
        raise DomainError(f"Invalid month {month!r}")
    today = schedule.today()
    if month > month_key(today):
        raise DomainError("That month hasn't started yet.")
    start, end = month_bounds(month)
    days_in_month = (end - start).days
    is_complete = month < month_key(today)
    days_elapsed = days_in_month if is_complete else today.day

    # Averages use up to three prior months that have any activity, so a short history
    # isn't diluted by empty months.
    used = recent_active_months(db, month)
    n = len(used)

    def avg(values: list[Decimal]) -> Decimal | None:
        return (sum(values, Decimal(0)) / n).quantize(ZERO) if n else None

    (this,) = monthly_totals(db, [month])
    income_avg = avg([m.income for m in used])
    net_avg = avg([m.net for m in used])

    buckets = [
        (EssentialityFilter.ESSENTIAL, this.essential),
        (EssentialityFilter.FLEXIBLE, this.flexible),
        (EssentialityFilter.DISCRETIONARY, this.discretionary),
        (EssentialityFilter.UNSET, this.uncategorized),
    ]
    category_avgs = {c.category_id: c for c in category_totals(db, [m.month for m in used])}
    categories = []
    for c in category_totals(db, [month]):
        past = category_avgs.get(c.category_id)
        categories.append(
            MonthCategory(
                category_id=c.category_id,
                label=c.label,
                primary=c.primary,
                total=c.total,
                count=c.count,
                average=avg(list(past.monthly.values())) if past else (ZERO if n else None),
            )
        )

    ids = largest_expense_ids(db, start, end)
    by_id = {
        t.id: t
        for t in db.scalars(
            select(Transaction)
            .where(Transaction.id.in_(ids))
            .options(selectinload(Transaction.categorization))
        )
    }
    _, review_count = transactions_service.list_transactions(
        db,
        q=None,
        start=start,
        end=end - timedelta(days=1),
        account_ids=None,
        category_ids=None,
        essentiality=None,
        uncategorized=False,
        needs_review=True,
        include_transfers=False,
        limit=1,
        offset=0,
    )
    transaction_count = (
        db.scalar(
            select(func.count())
            .select_from(Transaction)
            .where(
                Transaction.is_transfer.is_(False),
                Transaction.posted_on >= start,
                Transaction.posted_on < end,
            )
        )
        or 0
    )

    return MonthDetail(
        month=month,
        is_complete=is_complete,
        days_elapsed=days_elapsed,
        days_in_month=days_in_month,
        average_months=n,
        income=this.income,
        income_average=income_avg,
        expenses=this.expenses,
        expenses_average=avg([m.expenses for m in used]),
        net=this.net,
        net_average=net_avg,
        savings_rate=_rate(this.net, this.income),
        savings_rate_average=_rate(net_avg, income_avg)
        if net_avg is not None and income_avg
        else None,
        essentiality=[
            EssentialityShare(
                essentiality=e,
                total=total,
                share=round(float(total / this.expenses), 4) if this.expenses else 0.0,
            )
            for e, total in buckets
        ],
        categories=categories,
        largest=[TransactionRead.model_validate(by_id[i]) for i in ids if i in by_id],
        transaction_count=transaction_count,
        review_count=review_count,
    )
