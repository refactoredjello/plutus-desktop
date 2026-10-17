"""Recurring charge detection and management (R6). Owned by the Wave 2 insight brief.

detect_recurring is called by services/sync.py after categorization. Keep its signature stable.
"""

from collections import defaultdict
from datetime import date
from decimal import Decimal
from itertools import pairwise
from statistics import median
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import DomainError, NotFoundError
from app.models import Categorization, RecurringCharge, Transaction
from app.models.base import Cadence, Essentiality, RecurrenceStatus
from app.services import schedule
from app.services.aggregates import ZERO
from app.services.schedule import MONTH_END_FROM, add_months, next_after

MIN_OCCURRENCES = 3
LOOKBACK_MONTHS = 18
AMOUNT_TOLERANCE = Decimal("0.15")
# Allowed gap in days between consecutive occurrences, per cadence.
GAP_BANDS: dict[Cadence, tuple[int, int]] = {
    Cadence.WEEKLY: (6, 8),
    Cadence.BIWEEKLY: (13, 15),
    Cadence.MONTHLY: (27, 33),
    Cadence.YEARLY: (350, 380),
}
PER_YEAR: dict[Cadence, int] = {
    Cadence.WEEKLY: 52,
    Cadence.BIWEEKLY: 26,
    Cadence.SEMIMONTHLY: 24,
    Cadence.MONTHLY: 12,
    Cadence.YEARLY: 1,
}


def annual_cost(charge: RecurringCharge) -> Decimal:
    """Amount times occurrences per year, signed like the amount."""
    return (charge.amount * PER_YEAR[charge.cadence]).quantize(ZERO)


SEMIMONTHLY_GAPS = (12, 19)
SEMIMONTHLY_SPREAD = 2  # max spread in days of month inside each of the two clusters


def _is_semimonthly_days(dates: list[date]) -> bool:
    """True when days of month form two tight clusters about half a month apart.

    Days of 28+ count as month end (30). A true biweekly series drifts through the month,
    so it never forms two clusters.
    """
    days = sorted({30 if d.day >= MONTH_END_FROM else d.day for d in dates})
    if len(days) < 2:
        return False
    cut = max(range(1, len(days)), key=lambda i: days[i] - days[i - 1])
    low, high = days[:cut], days[cut:]
    if max(low) - min(low) > SEMIMONTHLY_SPREAD or max(high) - min(high) > SEMIMONTHLY_SPREAD:
        return False
    centers = (sum(high) / len(high)) - (sum(low) / len(low))
    return 12 <= centers <= 19


def detect_cadence(dates: list[date]) -> Cadence | None:
    """The cadence whose band holds the median gap and most (all but a quarter) of the gaps.

    Semimonthly is decided first: gaps mostly 12-19 days and days of month in two clusters.
    """
    gaps = [(b - a).days for a, b in pairwise(dates)]
    if not gaps:
        return None
    low_gap, high_gap = SEMIMONTHLY_GAPS
    in_band = sum(1 for g in gaps if low_gap <= g <= high_gap)
    if in_band * 4 >= len(gaps) * 3 and _is_semimonthly_days(dates):
        return Cadence.SEMIMONTHLY
    mid = median(gaps)
    for cadence, (low, high) in GAP_BANDS.items():
        if low <= mid <= high:
            inside = sum(1 for g in gaps if low <= g <= high)
            return cadence if inside * 4 >= len(gaps) * 3 else None
    return None


def amounts_consistent(amounts: list[Decimal]) -> bool:
    """At least three quarters of amounts within 15% of the median.

    Like gaps, this tolerates the odd outlier, e.g. a paycheck that includes a bonus.
    """
    mid = Decimal(median(amounts))
    if mid == 0:
        return False
    close = sum(1 for a in amounts if abs(a - mid) <= abs(mid) * AMOUNT_TOLERANCE)
    return close * 4 >= len(amounts) * 3


def _dominant_direction(items: list[tuple[date, Decimal]]) -> list[tuple[date, Decimal]]:
    """Keep only the majority sign: a refund or reversal is not part of a bill's or paycheck's
    pattern. Ties keep outflows."""
    inflows = [i for i in items if i[1] > 0]
    outflows = [i for i in items if i[1] < 0]
    return inflows if len(inflows) > len(outflows) else outflows


def detect_recurring(db: Session) -> int:
    """Propose or refresh recurring charges from transaction history.

    Returns the number of recurrences created or updated. Does not commit.
    """
    rows = db.execute(
        select(
            Transaction.merchant_key,
            Transaction.account_id,
            Transaction.posted_on,
            Transaction.amount,
        )
        .where(
            Transaction.is_transfer.is_(False),
            Transaction.pending.is_(False),
            Transaction.merchant_key.is_not(None),
            Transaction.posted_on >= add_months(schedule.today(), -LOOKBACK_MONTHS),
        )
        .order_by(Transaction.posted_on, Transaction.id)
    )
    groups: dict[tuple[str, int], list[tuple[date, Decimal]]] = defaultdict(list)
    for key, account_id, posted_on, amount in rows:
        if key is not None:
            groups[(key, account_id)].append((posted_on, amount))

    existing = {(r.merchant_key, r.account_id): r for r in db.scalars(select(RecurringCharge))}
    essentiality = _latest_essentiality(db)
    changed = 0
    for (key, account_id), all_items in groups.items():
        items = _dominant_direction(all_items)
        found = existing.get((key, account_id))
        if found is not None and found.status == RecurrenceStatus.DISMISSED:
            continue
        dates = [d for d, _ in items]
        amounts = [a for _, a in items]
        cadence = detect_cadence(dates) if len(items) >= MIN_OCCURRENCES else None
        if cadence is None or not amounts_consistent(amounts):
            # Too few or irregular to detect, e.g. a yearly fee the owner marked by hand.
            # Still keep an existing recurrence's dates current.
            if (
                found is not None
                and dates
                and (found.last_seen_on is None or dates[-1] > found.last_seen_on)
            ):
                found.last_seen_on = dates[-1]
                found.next_expected_date = next_after(dates[-1], found.cadence)
                changed += 1
            continue
        amount = Decimal(median(amounts[-3:])).quantize(ZERO)
        last = dates[-1]
        if found is None:
            db.add(
                RecurringCharge(
                    merchant_key=key,
                    account_id=account_id,
                    amount=amount,
                    cadence=cadence,
                    next_expected_date=next_after(last, cadence),
                    last_seen_on=last,
                    status=RecurrenceStatus.PROPOSED,
                    essentiality=essentiality.get(key),
                )
            )
            changed += 1
            continue
        nxt = next_after(last, found.cadence)
        if (found.amount, found.last_seen_on, found.next_expected_date) != (amount, last, nxt):
            found.amount = amount
            found.last_seen_on = last
            found.next_expected_date = nxt
            changed += 1
        if found.essentiality is None and key in essentiality:
            found.essentiality = essentiality[key]
            changed += 1
    db.flush()
    return changed


def _latest_essentiality(db: Session) -> dict[str, Essentiality]:
    """Essentiality of each merchant's most recent categorized transaction."""
    out: dict[str, Essentiality] = {}
    stmt = (
        select(Transaction.merchant_key, Categorization.essentiality)
        .join(Categorization, Categorization.transaction_id == Transaction.id)
        .where(Transaction.merchant_key.is_not(None), Categorization.essentiality.is_not(None))
        .order_by(Transaction.posted_on, Transaction.id)
    )
    for key, value in db.execute(stmt):
        if key is not None and value is not None:
            out[key] = value  # later rows overwrite earlier ones
    return out


def mark_recurring(db: Session, transaction_id: int, cadence: Cadence) -> RecurringCharge:
    """Confirm a transaction's merchant as recurring at `cadence`. Commits.

    For charges detection can't find on its own: yearly fees, or too little history.
    Re-marking an existing (even dismissed) recurrence updates and confirms it.
    """
    tx = db.get(Transaction, transaction_id)
    if tx is None:
        raise NotFoundError(f"Transaction {transaction_id} not found")
    if tx.is_transfer:
        raise DomainError("Transfers between your accounts can't be recurring charges.")
    if not tx.merchant_key:
        raise DomainError("This transaction has no merchant yet; categorize it first.")
    nxt = next_after(tx.posted_on, cadence)
    while nxt <= schedule.today():
        nxt = next_after(nxt, cadence)
    charge = db.scalar(
        select(RecurringCharge).where(
            RecurringCharge.merchant_key == tx.merchant_key,
            RecurringCharge.account_id == tx.account_id,
        )
    )
    if charge is None:
        charge = RecurringCharge(merchant_key=tx.merchant_key, account_id=tx.account_id)
        db.add(charge)
    charge.amount = tx.amount
    charge.cadence = cadence
    charge.last_seen_on = tx.posted_on
    charge.next_expected_date = nxt
    charge.status = RecurrenceStatus.CONFIRMED
    if tx.categorization is not None and tx.categorization.essentiality is not None:
        charge.essentiality = tx.categorization.essentiality
    db.commit()
    return charge


def list_recurring(db: Session, status: RecurrenceStatus | None = None) -> list[RecurringCharge]:
    stmt = select(RecurringCharge).order_by(RecurringCharge.next_expected_date, RecurringCharge.id)
    if status is None:
        stmt = stmt.where(RecurringCharge.status != RecurrenceStatus.DISMISSED)
    else:
        stmt = stmt.where(RecurringCharge.status == status)
    return list(db.scalars(stmt))


def update_recurring(db: Session, recurring_id: int, changes: dict[str, Any]) -> RecurringCharge:
    """Apply a partial update. Changing the cadence recomputes the next expected date."""
    charge = db.get(RecurringCharge, recurring_id)
    if charge is None:
        raise NotFoundError(f"Recurring charge {recurring_id} not found")
    for field in ("status", "amount", "cadence"):
        if changes.get(field) is not None:
            setattr(charge, field, changes[field])
    if "essentiality" in changes:
        charge.essentiality = changes["essentiality"]
    if changes.get("cadence") is not None:
        charge.next_expected_date = next_after(
            charge.last_seen_on or charge.next_expected_date, charge.cadence
        )
    db.commit()
    return charge
