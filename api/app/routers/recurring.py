"""Owned by Wave 2 insight brief."""

from fastapi import APIRouter, status

from app.deps import DbSession
from app.models import RecurringCharge
from app.models.base import RecurrenceStatus
from app.schemas.recurring import (
    RecurringChargeCreate,
    RecurringChargeRead,
    RecurringChargeUpdate,
)
from app.services import recurring as service

router = APIRouter(prefix="/recurring", tags=["recurring"])


def _read(charge: RecurringCharge) -> RecurringChargeRead:
    return RecurringChargeRead(
        id=charge.id,
        merchant_key=charge.merchant_key,
        account_id=charge.account_id,
        amount=charge.amount,
        cadence=charge.cadence,
        next_expected_date=charge.next_expected_date,
        last_seen_on=charge.last_seen_on,
        status=charge.status,
        essentiality=charge.essentiality,
        annual_cost=service.annual_cost(charge),
    )


@router.get("", response_model=list[RecurringChargeRead])
def list_recurring(
    db: DbSession, status: RecurrenceStatus | None = None
) -> list[RecurringChargeRead]:
    return [_read(c) for c in service.list_recurring(db, status)]


@router.post("", response_model=RecurringChargeRead, status_code=status.HTTP_201_CREATED)
def mark_recurring(body: RecurringChargeCreate, db: DbSession) -> RecurringChargeRead:
    """Mark a transaction's merchant as a confirmed recurring charge."""
    return _read(service.mark_recurring(db, body.transaction_id, body.cadence))


@router.patch("/{recurring_id}", response_model=RecurringChargeRead)
def update_recurring(
    recurring_id: int, body: RecurringChargeUpdate, db: DbSession
) -> RecurringChargeRead:
    return _read(service.update_recurring(db, recurring_id, body.model_dump(exclude_unset=True)))
