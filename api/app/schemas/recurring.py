from datetime import date

from app.models.base import Cadence, Essentiality, RecurrenceStatus
from app.schemas.common import Money, ReadSchema, Schema


class RecurringChargeRead(ReadSchema):
    id: int
    merchant_key: str
    account_id: int
    amount: Money
    cadence: Cadence
    next_expected_date: date
    last_seen_on: date | None
    status: RecurrenceStatus
    essentiality: Essentiality | None
    annual_cost: Money


class RecurringChargeCreate(Schema):
    """Mark a transaction's merchant as recurring (confirmed) at the given cadence."""

    transaction_id: int
    cadence: Cadence


class RecurringChargeUpdate(Schema):
    status: RecurrenceStatus | None = None
    essentiality: Essentiality | None = None
    amount: Money | None = None
    cadence: Cadence | None = None
