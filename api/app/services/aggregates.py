"""Shared monthly totals (R4, R7, R8).

Orchestrator-owned: reports, projection, and goals all build on these definitions.

Definitions, applied everywhere:
- Transfers between owned accounts (is_transfer) are excluded entirely.
- Money movement is excluded too, even when the other side is not paired: credit card
  payments (spending is counted when the purchase posts on the card), account, savings,
  and investment transfers. See MONEY_MOVEMENT. Peer-to-peer apps, wires, withdrawals, and
  loan payments stay counted: that money really leaves.
- Income: money in whose category is INCOME or TRANSFER_IN (e.g. deposits), or that is not
  categorized yet.
- Expenses: everything else, as a positive number. A refund in a spending category
  (money in, non-income category) reduces expenses instead of counting as income.
- Months are calendar months of posted_on, formatted YYYY-MM.
"""

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import ColumnElement, Select, and_, case, func, or_, select, true
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.orm import Session

from app.models import Account, BalanceSnapshot, Categorization, Category, Transaction
from app.models.base import Essentiality, EssentialityFilter

ZERO = Decimal("0.00")
INCOME_PRIMARIES = ("INCOME", "TRANSFER_IN")
MONEY_MOVEMENT = (
    "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
    "TRANSFER_IN_ACCOUNT_TRANSFER",
    "TRANSFER_OUT_ACCOUNT_TRANSFER",
    "TRANSFER_IN_SAVINGS",
    "TRANSFER_OUT_SAVINGS",
    "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS",
    "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS",
)


@dataclass(frozen=True)
class MonthTotals:
    month: str
    income: Decimal = ZERO
    expenses: Decimal = ZERO
    essential: Decimal = ZERO
    flexible: Decimal = ZERO
    discretionary: Decimal = ZERO
    uncategorized: Decimal = ZERO

    @property
    def net(self) -> Decimal:
        return self.income - self.expenses


@dataclass(frozen=True)
class CategoryMonthTotal:
    category_id: int | None
    label: str
    primary: str | None
    total: Decimal  # expenses, positive
    count: int
    monthly: dict[str, Decimal] = field(default_factory=dict)


@dataclass
class _CategoryAcc:
    label: str
    primary: str | None
    count: int = 0
    monthly: dict[str, Decimal] = field(default_factory=dict)


def month_key(day: date) -> str:
    return f"{day.year:04d}-{day.month:02d}"


def month_range(end: date, months: int) -> list[str]:
    """The `months` calendar months ending with the month of `end`, oldest first."""
    year, month = end.year, end.month
    out: list[str] = []
    for _ in range(months):
        out.append(f"{year:04d}-{month:02d}")
        month -= 1
        if month == 0:
            year, month = year - 1, 12
    return out[::-1]


def month_bounds(month: str) -> tuple[date, date]:
    """First day of `month` and first day of the following month."""
    year, mon = int(month[:4]), int(month[5:7])
    start = date(year, mon, 1)
    nxt = date(year + 1, 1, 1) if mon == 12 else date(year, mon + 1, 1)
    return start, nxt


def _is_income() -> ColumnElement[bool]:
    return and_(
        Transaction.amount > 0,
        or_(Categorization.category_id.is_(None), Category.primary.in_(INCOME_PRIMARIES)),
    )


def _base(start: date, end_exclusive: date) -> Select[tuple[object, ...]]:
    return (
        select()
        .select_from(Transaction)
        .outerjoin(Categorization, Categorization.transaction_id == Transaction.id)
        .outerjoin(Category, Category.id == Categorization.category_id)
        .where(
            Transaction.is_transfer.is_(False),
            or_(Category.detailed.is_(None), Category.detailed.not_in(MONEY_MOVEMENT)),
            Transaction.posted_on >= start,
            Transaction.posted_on < end_exclusive,
        )
    )


def _through_day(day: int | None) -> ColumnElement[bool]:
    """Only days 1..`day` of each month: "spent by this point in the month"."""
    return func.extract("day", Transaction.posted_on) <= day if day is not None else true()


def monthly_totals(
    db: Session, months: list[str], through_day: int | None = None
) -> list[MonthTotals]:
    """Totals for each month in `months` (YYYY-MM, oldest first), zero-filled.

    `through_day` limits each month to its first N days, for same-point-in-month pace.
    """
    if not months:
        return []
    start, _ = month_bounds(months[0])
    _, end = month_bounds(months[-1])
    month_col = func.to_char(Transaction.posted_on, "YYYY-MM")
    income = _is_income()
    expense_amount = case((income, 0), else_=-Transaction.amount)

    def by_essentiality(value: Essentiality | None) -> ColumnElement[Decimal]:
        cond = (
            Categorization.essentiality.is_(None)
            if value is None
            else Categorization.essentiality == value
        )
        return func.coalesce(func.sum(case((cond, expense_amount), else_=0)), 0)

    stmt = (
        _base(start, end)
        .where(_through_day(through_day))
        .add_columns(
            month_col,
            func.coalesce(func.sum(case((income, Transaction.amount), else_=0)), 0),
            func.coalesce(func.sum(expense_amount), 0),
            by_essentiality(Essentiality.ESSENTIAL),
            by_essentiality(Essentiality.FLEXIBLE),
            by_essentiality(Essentiality.DISCRETIONARY),
            by_essentiality(None),
        )
        .group_by(month_col)
    )
    found = {
        row[0]: MonthTotals(row[0], *(Decimal(v).quantize(ZERO) for v in row[1:]))
        for row in db.execute(stmt)
    }
    return [found.get(m, MonthTotals(m)) for m in months]


def essentiality_condition(value: EssentialityFilter) -> ColumnElement[bool]:
    """SQL condition on Categorization (outer-joined) for an essentiality filter."""
    if value is EssentialityFilter.UNSET:
        return Categorization.essentiality.is_(None)
    return Categorization.essentiality == Essentiality(value.value)


def category_totals(
    db: Session,
    months: list[str],
    essentiality: EssentialityFilter | None = None,
    through_day: int | None = None,
) -> list[CategoryMonthTotal]:
    """Expenses per category over `months`, with a per-month breakdown. Largest first.

    Uncategorized spending is one row with category_id None. `essentiality` narrows to one
    bucket; `unset` covers spending with no essentiality, including uncategorized spending.
    """
    if not months:
        return []
    start, _ = month_bounds(months[0])
    _, end = month_bounds(months[-1])
    month_col = func.to_char(Transaction.posted_on, "YYYY-MM")
    expense_amount = -Transaction.amount
    stmt = (
        _base(start, end)
        .where(_through_day(through_day))
        .add_columns(
            Category.id,
            Category.label,
            Category.primary,
            month_col,
            func.sum(expense_amount),
            func.count(Transaction.id),
        )
        .where(~_is_income())
        .where(essentiality_condition(essentiality) if essentiality else true())
        .group_by(Category.id, Category.label, Category.primary, month_col)
    )
    acc: dict[int | None, _CategoryAcc] = {}
    for cat_id, label, primary, month, total, count in db.execute(stmt):
        entry = acc.setdefault(cat_id, _CategoryAcc(label or "Uncategorized", primary))
        entry.count += int(count)
        entry.monthly[month] = Decimal(total).quantize(ZERO)
    out = [
        CategoryMonthTotal(
            category_id=cat_id,
            label=e.label,
            primary=e.primary,
            total=sum(e.monthly.values(), ZERO),
            count=e.count,
            monthly=e.monthly,
        )
        for cat_id, e in acc.items()
    ]
    return sorted(out, key=lambda c: c.total, reverse=True)


def current_total_balance(db: Session) -> Decimal:
    """Sum of each active account's latest snapshot balance. Credit balances are negative."""
    latest = (
        select(BalanceSnapshot.balance)
        .join(Account, Account.id == BalanceSnapshot.account_id)
        .where(Account.is_active.is_(True))
        .ext(distinct_on(BalanceSnapshot.account_id))
        .order_by(
            BalanceSnapshot.account_id, BalanceSnapshot.as_of.desc(), BalanceSnapshot.id.desc()
        )
        .subquery()
    )
    total = db.scalar(select(func.coalesce(func.sum(latest.c.balance), 0)))
    return Decimal(total or 0).quantize(ZERO)


def expenses_between(
    db: Session,
    start: date,
    end_exclusive: date,
    exclude_merchant_keys: Iterable[str] = (),
    *,
    exclude_one_time: bool = False,
) -> Decimal:
    """Total expenses (positive) posted in [start, end_exclusive), optionally skipping merchants.

    `exclude_one_time` drops owner-marked one-offs: for a "what do I usually spend" figure,
    not for totals of what was actually spent.
    """
    expense_amount = case((_is_income(), 0), else_=-Transaction.amount)
    stmt = _base(start, end_exclusive).add_columns(func.coalesce(func.sum(expense_amount), 0))
    keys = list(exclude_merchant_keys)
    if keys:
        stmt = stmt.where(
            or_(Transaction.merchant_key.is_(None), Transaction.merchant_key.not_in(keys))
        )
    if exclude_one_time:
        stmt = stmt.where(Transaction.one_time.is_(False))
    return Decimal(db.execute(stmt).scalar_one()).quantize(ZERO)


def income_between(
    db: Session, start: date, end_exclusive: date, exclude_merchant_keys: Iterable[str] = ()
) -> Decimal:
    """Total income posted in [start, end_exclusive), optionally skipping merchants."""
    income_amount = case((_is_income(), Transaction.amount), else_=0)
    stmt = _base(start, end_exclusive).add_columns(func.coalesce(func.sum(income_amount), 0))
    keys = list(exclude_merchant_keys)
    if keys:
        stmt = stmt.where(
            or_(Transaction.merchant_key.is_(None), Transaction.merchant_key.not_in(keys))
        )
    return Decimal(db.execute(stmt).scalar_one()).quantize(ZERO)


def largest_expense_ids(db: Session, start: date, end_exclusive: date, limit: int = 5) -> list[int]:
    """Ids of the largest expenses (aggregates' definition) posted in [start, end_exclusive)."""
    stmt = (
        _base(start, end_exclusive)
        .add_columns(Transaction.id)
        .where(~_is_income(), Transaction.amount < 0)
        .order_by(Transaction.amount.asc(), Transaction.id.asc())
        .limit(limit)
    )
    return [row[0] for row in db.execute(stmt)]


AVERAGE_MONTHS = 3
LOOKBACK_FOR_AVERAGE = 12


def recent_active_months(db: Session, month: str, n: int = AVERAGE_MONTHS) -> list[MonthTotals]:
    """Up to `n` months before `month` that had any activity, oldest first.

    "Usual" everywhere (Month page, What changed) means the average of these, so a short
    history isn't diluted by empty months.
    """
    start, _ = month_bounds(month)
    prior = monthly_totals(db, month_range(start - timedelta(days=1), LOOKBACK_FOR_AVERAGE))
    return [m for m in prior if m.income != 0 or m.expenses != 0][-n:]


def _expenses_query(start: date, end_exclusive: date) -> Select[tuple[object, ...]]:
    return _base(start, end_exclusive).where(~_is_income(), Transaction.amount < 0)


def expense_ids(
    db: Session, start: date, end_exclusive: date, min_amount: Decimal = ZERO
) -> list[int]:
    """Ids of expenses of at least `min_amount` in [start, end_exclusive), largest first."""
    stmt = (
        _expenses_query(start, end_exclusive)
        .add_columns(Transaction.id)
        .where(-Transaction.amount >= min_amount)
        .order_by(Transaction.amount.asc(), Transaction.id.asc())
    )
    return [row[0] for row in db.execute(stmt)]


def expense_amounts(db: Session, start: date, end_exclusive: date) -> list[Decimal]:
    """Positive expense amounts in [start, end_exclusive), for medians and percentiles."""
    stmt = _expenses_query(start, end_exclusive).add_columns(-Transaction.amount)
    return [Decimal(row[0]) for row in db.execute(stmt)]
