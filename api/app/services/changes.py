"""What changed (R12): deterministic signals about the current month. No LLM involvement.

Each signal is a rule over the shared aggregates (services/aggregates.py), so figures match
the Month page. Thresholds are module constants; there is no UI to tune them in v1.
"""

import string
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from statistics import median
from urllib.parse import urlencode

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models import (
    ChangeDismissal,
    ManualEntry,
    RecurringCharge,
    Transaction,
)
from app.models.base import Recurrence, RecurrenceStatus
from app.schemas.changes import ChangeItem, ChangesRead
from app.services import projection
from app.services import transactions as transactions_service
from app.services.aggregates import (
    ZERO,
    MonthTotals,
    category_totals,
    expense_amounts,
    expense_ids,
    month_bounds,
    month_key,
    monthly_totals,
    recent_active_months,
)

# Thresholds (R12.2). Changing a number here changes the product; keep the PRD in sync.
RECURRING_CHANGE_PCT = Decimal("0.10")  # S1
RECURRING_CHANGE_MIN = Decimal("5")  # S1
MISSING_GRACE_DAYS = 7  # S2
CATEGORY_ABOVE_PCT = Decimal("0.30")  # S4
CATEGORY_ABOVE_MIN = Decimal("75")  # S4
NEW_MERCHANT_MIN = Decimal("200")  # S5
LARGE_EXPENSE_MULTIPLE = Decimal("3")  # S6
LARGE_EXPENSE_MIN = Decimal("250")  # S6
MEDIAN_WINDOW_DAYS = 90  # S6
REVIEW_COUNT_MIN = 10  # S7
REVIEW_SINGLE_MIN = Decimal("100")  # S7
REVIEW_SCAN_LIMIT = 500  # S7: the queue is small; cap the scan
DISCRETIONARY_PACE_PCT = Decimal("0.25")  # S8
MAX_ITEMS = 7  # R12.3
DISMISSAL_RETENTION_DAYS = 90  # R12.6


@dataclass(frozen=True)
class _Item:
    signal: str
    impact: Decimal  # dollar impact, for ordering within a signal
    key: str
    text: str
    amount: Decimal | None
    href: str

    @property
    def priority(self) -> int:
        return int(self.signal[1:])


def money(value: Decimal) -> str:
    """Whole dollars from $100 up; cents below, so "$15.49 to $22.99" stays readable."""
    sign = "\N{MINUS SIGN}" if value < 0 else ""
    v = abs(value)
    return f"{sign}${v:,.0f}" if v >= 100 else f"{sign}${v:,.2f}"


def short_date(day: date) -> str:
    return f"{day:%b} {day.day}"


def _cents(value: Decimal) -> int:
    return int((abs(value) * 100).quantize(Decimal(1)))


def _transactions_href(start: date, end_exclusive: date, **params: str) -> str:
    query = {
        **params,
        "start": start.isoformat(),
        "end": (end_exclusive - timedelta(days=1)).isoformat(),
    }
    return f"/transactions?{urlencode(query)}"


def merchant_label(db: Session, merchant_key: str) -> str:
    """How the app displays a merchant: the latest payee, else the cleaned merchant key."""
    payee = db.scalar(
        select(Transaction.payee)
        .where(Transaction.merchant_key == merchant_key, Transaction.payee.is_not(None))
        .order_by(Transaction.posted_on.desc())
        .limit(1)
    )
    return payee or string.capwords(merchant_key.lower())


def _tx_label(tx: Transaction) -> str:
    if tx.payee:
        return tx.payee
    return string.capwords((tx.merchant_key or tx.raw_description).lower())


def _pct(part: Decimal, whole: Decimal) -> int:
    return round(float(part / whole * 100))


# --- signals -------------------------------------------------------------------------------


def _s1_recurring_changed(db: Session, charges: list[RecurringCharge]) -> list[_Item]:
    items = []
    for c in charges:
        latest = db.scalar(
            select(Transaction)
            .where(
                Transaction.merchant_key == c.merchant_key,
                Transaction.account_id == c.account_id,
                Transaction.pending.is_(False),
                Transaction.is_transfer.is_(False),
            )
            .order_by(Transaction.posted_on.desc(), Transaction.id.desc())
            .limit(1)
        )
        if latest is None:
            continue
        diff = abs(latest.amount - c.amount)
        if diff <= max(abs(c.amount) * RECURRING_CHANGE_PCT, RECURRING_CHANGE_MIN):
            continue
        name = merchant_label(db, c.merchant_key)
        items.append(
            _Item(
                "S1",
                diff,
                f"S1:recurrence:{c.id}:{_cents(latest.amount)}",
                f"{name} went from {money(abs(c.amount))} to {money(abs(latest.amount))}.",
                abs(latest.amount),
                "/recurring",
            )
        )
    return items


def _s2_recurring_missing(db: Session, charges: list[RecurringCharge], today: date) -> list[_Item]:
    items = []
    for c in charges:
        # Lapsed (two periods unseen) means probably cancelled: the projection already drops it.
        if projection.is_lapsed(c, today):
            continue
        overdue = c.next_expected_date < today - timedelta(days=MISSING_GRACE_DAYS)
        seen_since = c.last_seen_on is not None and c.last_seen_on >= c.next_expected_date
        if not overdue or seen_since:
            continue
        name = merchant_label(db, c.merchant_key)
        items.append(
            _Item(
                "S2",
                abs(c.amount),
                f"S2:recurrence:{c.id}:{c.next_expected_date.isoformat()}",
                f"{name} hasn't posted; expected {short_date(c.next_expected_date)}.",
                abs(c.amount),
                "/recurring",
            )
        )
    return items


def _s3_planned_overdue(db: Session, today: date) -> list[_Item]:
    entries = db.scalars(
        select(ManualEntry).where(
            ManualEntry.recurrence == Recurrence.NONE,
            ManualEntry.fulfilled_transaction_id.is_(None),
            ManualEntry.due_date < today,
        )
    )
    return [
        _Item(
            "S3",
            abs(e.amount),
            f"S3:entry:{e.id}:{e.due_date.isoformat()}",
            f"{e.description} ({money(abs(e.amount))}) was due {short_date(e.due_date)} "
            "and hasn't matched a transaction.",
            abs(e.amount),
            "/planned",
        )
        for e in entries
    ]


def _s4_category_above(
    db: Session, month: str, used: list[MonthTotals], day: int | None, complete: bool
) -> list[_Item]:
    """`day` limits the usual months to the same point in the month (None for whole months).

    Comparing with "spent by this day" rather than a prorated average keeps once-a-month
    bills (a loan on the 1st) from looking far above pace early in the month.
    """
    if not used:
        return []
    start, end = month_bounds(month)
    past = {c.category_id: c for c in category_totals(db, [m.month for m in used], through_day=day)}
    items = []
    for c in category_totals(db, [month]):
        if c.category_id is None:  # Uncategorized is the Review queue's job
            continue
        prior = past.get(c.category_id)
        expected = sum(prior.monthly.values(), ZERO) / len(used) if prior else ZERO
        excess = c.total - expected
        if expected <= 0 or excess <= expected * CATEGORY_ABOVE_PCT or excess <= CATEGORY_ABOVE_MIN:
            continue
        pct = _pct(excess, expected)
        text = (
            f"{c.label} was {money(c.total)}, {pct}% above usual."
            if complete
            else f"{c.label} is {money(c.total)} so far, {pct}% above your usual pace."
        )
        items.append(
            _Item(
                "S4",
                excess,
                f"S4:category:{c.category_id}:{month}",
                text,
                c.total,
                _transactions_href(start, end, category=str(c.category_id)),
            )
        )
    return items


def _s5_new_merchants(db: Session, month: str) -> tuple[list[_Item], set[str]]:
    start, end = month_bounds(month)
    ids = expense_ids(db, start, end, NEW_MERCHANT_MIN)
    if not ids:
        return [], set()
    txs = db.scalars(select(Transaction).where(Transaction.id.in_(ids))).all()
    seen_before = set(
        db.scalars(
            select(Transaction.merchant_key)
            .where(
                Transaction.merchant_key.in_({t.merchant_key for t in txs if t.merchant_key}),
                Transaction.posted_on < start,
            )
            .distinct()
        )
    )
    largest: dict[str, Transaction] = {}
    for t in txs:
        key = t.merchant_key
        if (
            key
            and key not in seen_before
            and (key not in largest or t.amount < largest[key].amount)
        ):
            largest[key] = t
    items = [
        _Item(
            "S5",
            abs(t.amount),
            f"S5:merchant:{key}:{month}",
            f"First purchase at {_tx_label(t)}: {money(abs(t.amount))}.",
            abs(t.amount),
            _transactions_href(start, end, q=t.payee or t.raw_description),
        )
        for key, t in largest.items()
    ]
    return items, set(largest)


def _s6_large_expenses(
    db: Session, month: str, today: date, skip_merchants: set[str], recurring_keys: set[str]
) -> list[_Item]:
    window = expense_amounts(
        db, today - timedelta(days=MEDIAN_WINDOW_DAYS), today + timedelta(days=1)
    )
    if not window:
        return []
    threshold = max(Decimal(median(window)) * LARGE_EXPENSE_MULTIPLE, LARGE_EXPENSE_MIN)
    start, end = month_bounds(month)
    ids = expense_ids(db, start, end, threshold)
    items = []
    for t in db.scalars(select(Transaction).where(Transaction.id.in_(ids))):
        # Known recurring charges (rent, loans) are expected, and S5 already reports new merchants.
        if t.merchant_key in skip_merchants or t.merchant_key in recurring_keys:
            continue
        if _seen_similar_before(db, t, start):
            continue
        items.append(
            _Item(
                "S6",
                abs(t.amount),
                f"S6:transaction:{t.id}",
                f"{money(abs(t.amount))} to {_tx_label(t)} on {short_date(t.posted_on)}.",
                abs(t.amount),
                _transactions_href(start, end, q=t.payee or t.raw_description),
            )
        )
    return items


SIMILAR_AMOUNT_PCT = Decimal("0.15")  # S6: a recent charge this close means it's regular
SIMILAR_LOOKBACK_DAYS = 100  # S6


def _seen_similar_before(db: Session, t: Transaction, month_start: date) -> bool:
    """Same merchant charged within 15% of this amount in the ~3 months before this month."""
    if not t.merchant_key:
        return False
    low, high = sorted((t.amount * (1 - SIMILAR_AMOUNT_PCT), t.amount * (1 + SIMILAR_AMOUNT_PCT)))
    found = db.scalar(
        select(Transaction.id)
        .where(
            Transaction.merchant_key == t.merchant_key,
            Transaction.posted_on >= month_start - timedelta(days=SIMILAR_LOOKBACK_DAYS),
            Transaction.posted_on < month_start,
            Transaction.amount.between(low, high),
        )
        .limit(1)
    )
    return found is not None


def _s7_review_backlog(db: Session) -> list[_Item]:
    rows, total = transactions_service.list_transactions(
        db, q=None, start=None, end=None, account_ids=None, category_ids=None,
        essentiality=None, uncategorized=False, needs_review=True, include_transfers=False,
        limit=REVIEW_SCAN_LIMIT, offset=0,
    )  # fmt: skip
    if not rows:
        return []
    biggest = max(abs(t.amount) for t in rows)
    if total < REVIEW_COUNT_MIN and biggest <= REVIEW_SINGLE_MIN:
        return []
    if total == 1:
        text = f"A {money(biggest)} transaction needs review."
    elif biggest > REVIEW_SINGLE_MIN:
        text = f"{total} transactions need review, including one for {money(biggest)}."
    else:
        text = f"{total} transactions need review."
    return [_Item("S7", biggest, f"S7:review:{total}:{_cents(biggest)}", text, None, "/review")]


def _s8_discretionary_pace(
    db: Session, this: MonthTotals, used: list[MonthTotals], day: int, month: str
) -> list[_Item]:
    if not used:
        return []
    usual = monthly_totals(db, [m.month for m in used], through_day=day)
    expected = sum((m.discretionary for m in usual), ZERO) / len(used)
    excess = this.discretionary - expected
    if expected <= 0 or excess <= expected * DISCRETIONARY_PACE_PCT:
        return []
    return [
        _Item(
            "S8",
            excess,
            f"S8:discretionary:{month}",
            f"Discretionary spending is running {_pct(excess, expected)}% above usual.",
            None,
            f"/spending?{urlencode({'essentiality': 'discretionary', 'month': month})}",
        )
    ]


def _s9_projection_negative(db: Session, month: str) -> list[_Item]:
    end_balance = projection.project(db, months=1).months[0].projected_end_balance
    if end_balance >= 0:
        return []
    # "Only when the previous projection was not" needs history we don't store; the
    # month in the key means one dismissal holds for the month (see PR notes).
    return [
        _Item(
            "S9",
            abs(end_balance),
            f"S9:projection:{month}",
            f"Projected month-end balance is {money(end_balance)}.",
            end_balance,
            "/#balance",
        )
    ]


# --- entry points --------------------------------------------------------------------------


def compute(db: Session, today: date, *, include_all: bool = False) -> ChangesRead:
    month = month_key(today)
    used = recent_active_months(db, month)
    (this,) = monthly_totals(db, [month])

    charges = list(
        db.scalars(
            select(RecurringCharge).where(RecurringCharge.status == RecurrenceStatus.CONFIRMED)
        )
    )
    recurring_keys = set(
        db.scalars(
            select(RecurringCharge.merchant_key).where(
                RecurringCharge.status != RecurrenceStatus.DISMISSED
            )
        )
    )
    s5, s5_merchants = _s5_new_merchants(db, month)
    candidates = [
        *_s1_recurring_changed(db, charges),
        *_s2_recurring_missing(db, charges, today),
        *_s3_planned_overdue(db, today),
        *_s4_category_above(db, month, used, today.day, complete=False),
        *s5,
        *_s6_large_expenses(db, month, today, s5_merchants, recurring_keys),
        *_s7_review_backlog(db),
        *_s8_discretionary_pace(db, this, used, today.day, month),
        *_s9_projection_negative(db, month),
    ]
    dismissed = set(db.scalars(select(ChangeDismissal.key)))
    visible = sorted(
        (c for c in candidates if c.key not in dismissed), key=lambda c: (c.priority, -c.impact)
    )
    shown = visible if include_all else visible[:MAX_ITEMS]
    return ChangesRead(
        as_of=today,
        average_months=len(used),
        items=[
            ChangeItem(signal=c.signal, key=c.key, text=c.text, amount=c.amount, href=c.href)
            for c in shown
        ],
        hidden=len(visible) - len(shown),
    )


def dismiss(db: Session, key: str) -> None:
    """Hide an item until its fact changes. Commits."""
    if db.get(ChangeDismissal, key) is None:
        db.add(ChangeDismissal(key=key, signal=key.split(":", 1)[0][:10]))
    db.commit()


def clear_dismissals(db: Session) -> None:
    db.execute(delete(ChangeDismissal))
    db.commit()


def prune_dismissals(db: Session, now: datetime | None = None) -> int:
    """Drop dismissals older than the retention window. Does not commit."""
    cutoff = (now or datetime.now(UTC)) - timedelta(days=DISMISSAL_RETENTION_DAYS)
    result = db.scalars(
        delete(ChangeDismissal)
        .where(ChangeDismissal.dismissed_at < cutoff)
        .returning(ChangeDismissal.key)
    )
    return len(result.all())
