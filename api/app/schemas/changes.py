from datetime import date

from pydantic import BaseModel, Field

from app.schemas.common import Money, Schema


class ChangeItem(BaseModel):
    signal: str  # "S1".."S9"
    key: str  # dismissal key, stable for the underlying fact
    text: str  # the full sentence
    amount: Money | None  # the dollar figure the sentence leads with, for emphasis
    href: str  # frontend route with query parameters


class ChangesRead(BaseModel):
    as_of: date
    average_months: int  # prior months with activity behind the comparisons (0-3)
    items: list[ChangeItem]  # sorted; capped at 7 unless all=true
    hidden: int  # items beyond the cap


class DismissChange(Schema):
    key: str = Field(min_length=1, max_length=255)
