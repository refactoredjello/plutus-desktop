"""Cash projection (R7): current balance plus planned flows minus variable spending."""

import calendar
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import ManualEntry, RecurringCharge, Transaction
from app.models.base import Cadence, Recurrence, RecurrenceStatus
from app.schemas.projection import ProjectedMonth, ProjectionRead
from app.services import schedule
from app.services.aggregates import (
    ZERO,
    current_total_balance,
    expenses_between,
    income_between,
)

TRAILING_DAYS = 90
LAPSE_GRACE_DAYS = 7
CADENCE_DAYS = {
    Cadence.WEEKLY: 7,
    Cadence.BIWEEKLY: 14,
    Cadence.SEMIMONTHLY: 15,
    Cadence.MONTHLY: 30,
    Cadence.YEARLY: 365,
}


def is_lapsed(charge: RecurringCharge, today: date) -> bool:
    """Not seen for two cadence periods plus a grace period: probably cancelled."""
    if charge.last_seen_on is None:
        return False
    limit = 2 * CADENCE_DAYS[charge.cadence] + LAPSE_GRACE_DAYS
    return (today - charge.last_seen_on).days > limit


def _cents(value: Decimal) -> Decimal:
    return value.quantize(ZERO)


def covered_days(db: Session, today: date) -> int:
    """Days of history behind the average: at most 90, fewer for a new database."""
    earliest = db.scalar(
        select(func.min(Transaction.posted_on)).where(Transaction.is_transfer.is_(False))
    )
    if earliest is None:
        return TRAILING_DAYS
    return max(1, min(TRAILING_DAYS, (today - earliest).days))


def variable_daily_average(
    db: Session, today: date, excluded_keys: set[str], days: int = TRAILING_DAYS
) -> Decimal:
    """Trailing expenses (aggregates' definition) outside confirmed recurring merchants and
    owner-marked one-time transactions."""
    total = expenses_between(
        db,
        today - timedelta(days=TRAILING_DAYS - 1),
        today + timedelta(days=1),
        excluded_keys,
        exclude_one_time=True,
    )
    return max(total, Decimal(0)) / days


def variable_daily_income(
    db: Session, today: date, excluded_keys: set[str], days: int = TRAILING_DAYS
) -> Decimal:
    """Trailing income outside confirmed recurring items, e.g. a paycheck not yet confirmed."""
    total = income_between(
        db, today - timedelta(days=TRAILING_DAYS - 1), today + timedelta(days=1), excluded_keys
    )
    return max(total, Decimal(0)) / days


def project(db: Session, months: int = 3) -> ProjectionRead:
    today = schedule.today()
    all_confirmed = list(
        db.scalars(
            select(RecurringCharge).where(RecurringCharge.status == RecurrenceStatus.CONFIRMED)
        )
    )
    confirmed = [c for c in all_confirmed if not is_lapsed(c, today)]
    lapsed = len(all_confirmed) - len(confirmed)
    entries = [
        e
        for e in db.scalars(
            select(ManualEntry).where(
                or_(ManualEntry.end_date.is_(None), ManualEntry.end_date > today)
            )
        )
        if e.fulfilled_transaction_id is None
        and (e.recurrence != Recurrence.NONE or e.due_date > today)
    ]
    window = covered_days(db, today)
    # Lapsed merchants stay excluded from variable spending: they are still recurring ones.
    recurring_keys = {c.merchant_key for c in all_confirmed}
    daily = variable_daily_average(db, today, recurring_keys, window)
    daily_income = variable_daily_income(db, today, recurring_keys, window)

    current = current_total_balance(db)
    balance = current
    out: list[ProjectedMonth] = []
    year, month = today.year, today.month
    for index in range(months):
        last = date(year, month, calendar.monthrange(year, month)[1])
        after = today if index == 0 else date(year, month, 1) - timedelta(days=1)
        days = (last - after).days

        rec_in = rec_out = man_in = man_out = Decimal(0)
        for c in confirmed:
            for _ in schedule.occurrences(c.next_expected_date, c.cadence, after, last):
                if c.amount > 0:
                    rec_in += c.amount
                else:
                    rec_out -= c.amount
        for e in entries:
            for d in schedule.occurrences(e.due_date, e.recurrence, after, last):
                if e.end_date is not None and d > e.end_date:
                    break
                if e.amount > 0:
                    man_in += e.amount
                else:
                    man_out -= e.amount
        variable = _cents(daily * days)
        variable_in = _cents(daily_income * days)
        start = balance
        balance = _cents(start + rec_in + man_in + variable_in - rec_out - man_out - variable)
        out.append(
            ProjectedMonth(
                month=f"{year:04d}-{month:02d}",
                starting_balance=start,
                recurring_income=_cents(rec_in),
                recurring_expenses=_cents(rec_out),
                manual_income=_cents(man_in),
                manual_expenses=_cents(man_out),
                variable_spending=variable,
                variable_income=variable_in,
                projected_end_balance=balance,
            )
        )
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)

    assumptions = [
        f"Variable spending averages ${_cents(daily)}/day over the last {window} days"
        + (" (all the history there is)" if window < TRAILING_DAYS else "")
        + ", excluding transfers, confirmed recurring charges, and one-time transactions.",
        f"Other income averages ${_cents(daily_income)}/day over the same period. Confirm "
        "paychecks on the Recurring page to project them on their actual dates.",
        f"{len(confirmed)} confirmed recurring "
        f"{'item is' if len(confirmed) == 1 else 'items are'} included at their usual amounts "
        "and cadence.",
        f"{len(entries)} planned manual "
        f"{'entry is' if len(entries) == 1 else 'entries are'} included on their due dates.",
        "The current month counts only days after today.",
    ]
    if lapsed:
        assumptions.insert(
            2,
            f"{lapsed} confirmed recurring item(s) left out because they haven't "
            "appeared recently.",
        )
    return ProjectionRead(as_of=today, current_balance=current, months=out, assumptions=assumptions)
