"""Date helpers shared by recurring detection and projection."""

import calendar
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta

from app.models.base import Cadence, Recurrence


def today() -> date:
    """The one place "today" comes from. Tests monkeypatch this."""
    return datetime.now(UTC).date()


def add_months(day: date, months: int) -> date:
    """`day` shifted by whole months, clamped to the end of the target month."""
    index = day.year * 12 + (day.month - 1) + months
    year, month = divmod(index, 12)
    month += 1
    last = calendar.monthrange(year, month)[1]
    return date(year, month, min(day.day, last))


MONTH_END_FROM = 28  # a day of month at or above this counts as "month end"


def _semimonthly(anchor: date, n: int) -> date:
    """Twice a month, alternating between a low and a high day of month.

    The pair comes from the anchor: a month-end anchor (day >= 28) pairs with the 15th; a day
    of 13-15 pairs with month end; any other day d <= 15 pairs with d + 15; a day above 15
    pairs with d - 15. Days clamp to the month's length. The anchor may be either half.
    """
    day = anchor.day
    if day >= MONTH_END_FROM:
        low, high, is_low = 15, None, False
    elif day > 15:
        low, high, is_low = day - 15, day, False
    elif day >= 13:
        low, high, is_low = day, None, True
    else:
        low, high, is_low = day, day + 15, True
    pos = (0 if is_low else 1) + n  # 2 * month offset + (0 low, 1 high)
    months, half = divmod(pos, 2)
    first = add_months(anchor.replace(day=1), months)
    month_last = calendar.monthrange(first.year, first.month)[1]
    target = low if half == 0 else (high if high is not None else month_last)
    return first.replace(day=min(target, month_last))


def nth_occurrence(anchor: date, cadence: Cadence | Recurrence, n: int) -> date:
    """The n-th occurrence after `anchor` (n=0 is the anchor). Computed from the anchor so
    month-end clamping never drifts (Jan 31 -> Feb 28 -> Mar 31)."""
    if cadence == "weekly":
        return anchor + timedelta(days=7 * n)
    if cadence == "biweekly":
        return anchor + timedelta(days=14 * n)
    if cadence == "monthly":
        return add_months(anchor, n)
    if cadence == "yearly":
        return add_months(anchor, 12 * n)
    if cadence == "semimonthly":
        return _semimonthly(anchor, n)
    raise ValueError(f"Cannot repeat with cadence {cadence!r}")


def next_after(day: date, cadence: Cadence) -> date:
    """One cadence step after `day`."""
    return nth_occurrence(day, cadence, 1)


def occurrences(
    anchor: date, cadence: Cadence | Recurrence, after: date, upto: date
) -> Iterator[date]:
    """Occurrence dates d with after < d <= upto. A non-repeating cadence yields the anchor once."""
    if cadence == Recurrence.NONE:
        if after < anchor <= upto:
            yield anchor
        return
    n = 0
    while (d := nth_occurrence(anchor, cadence, n)) <= upto:
        if d > after:
            yield d
        n += 1
