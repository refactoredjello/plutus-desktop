from datetime import date

from pydantic import BaseModel

from app.schemas.common import Money


class ProjectedMonth(BaseModel):
    month: str  # YYYY-MM
    starting_balance: Money
    recurring_income: Money
    recurring_expenses: Money
    manual_income: Money
    manual_expenses: Money
    variable_spending: Money
    variable_income: Money  # trailing average of income not covered by confirmed recurring items
    projected_end_balance: Money


class ProjectionRead(BaseModel):
    as_of: date
    current_balance: Money
    months: list[ProjectedMonth]
    assumptions: list[str]
