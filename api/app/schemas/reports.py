from datetime import date

from pydantic import BaseModel

from app.schemas.common import Money


class MonthlySummary(BaseModel):
    """Totals for one calendar month. Transfers excluded. Expenses are positive numbers."""

    month: str  # YYYY-MM
    income: Money
    expenses: Money
    net: Money
    essential: Money
    flexible: Money
    discretionary: Money
    uncategorized: Money


class CategoryTotal(BaseModel):
    category_id: int | None
    label: str
    primary: str | None
    total: Money
    count: int


class BalancePoint(BaseModel):
    on: date
    balance: Money


class AccountBalanceSeries(BaseModel):
    account_id: int
    name: str
    points: list[BalancePoint]
