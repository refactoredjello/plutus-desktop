from pydantic import BaseModel

from app.models.base import EssentialityFilter
from app.schemas.common import Money
from app.schemas.transactions import TransactionRead


class EssentialityShare(BaseModel):
    essentiality: EssentialityFilter
    total: Money
    share: float  # of the month's expenses, 0..1 (can exceed 1 or go negative with refunds)


class MonthCategory(BaseModel):
    category_id: int | None  # None = uncategorized spending
    label: str
    primary: str | None
    total: Money
    count: int
    average: Money | None  # over `average_months` prior months; None when there are none


class MonthDetail(BaseModel):
    """Everything the month view shows, on the shared aggregates definitions."""

    month: str  # YYYY-MM
    is_complete: bool
    days_elapsed: int
    days_in_month: int
    average_months: int  # prior months with data used for averages (0-3)
    income: Money
    income_average: Money | None
    expenses: Money
    expenses_average: Money | None
    net: Money
    net_average: Money | None
    savings_rate: float | None  # net / income; None when there is no income
    savings_rate_average: float | None
    essentiality: list[EssentialityShare]
    categories: list[MonthCategory]  # this month's spending, largest first
    largest: list[TransactionRead]
    transaction_count: int  # non-transfer transactions posted this month
    review_count: int  # of those, how many need review
