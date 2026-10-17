from datetime import date

from pydantic import Field

from app.models.base import Recurrence
from app.schemas.common import Money, ReadSchema, Schema


class ManualEntryRead(ReadSchema):
    id: int
    amount: Money
    description: str
    category_id: int | None
    due_date: date
    recurrence: Recurrence
    end_date: date | None
    fulfilled_transaction_id: int | None


class ManualEntryCreate(Schema):
    amount: Money
    description: str = Field(min_length=1, max_length=255)
    category_id: int | None = None
    due_date: date
    recurrence: Recurrence = Recurrence.NONE
    end_date: date | None = None


class ManualEntryUpdate(Schema):
    amount: Money | None = None
    description: str | None = Field(default=None, min_length=1, max_length=255)
    category_id: int | None = None
    due_date: date | None = None
    recurrence: Recurrence | None = None
    end_date: date | None = None
    fulfilled_transaction_id: int | None = None
