"""Manual entries: expected income (positive) or expenses (negative) not yet in bank data (R5)."""

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import DomainError, NotFoundError
from app.models import Category, ManualEntry, Transaction
from app.models.base import Recurrence
from app.schemas.manual_entries import ManualEntryCreate, ManualEntryUpdate

_REQUIRED = ("amount", "description", "due_date", "recurrence")


def _validate(db: Session, values: dict[str, Any]) -> None:
    end_date = values.get("end_date")
    if end_date is not None:
        if values["recurrence"] == Recurrence.NONE:
            raise DomainError("end_date must be empty when the entry does not recur")
        if end_date < values["due_date"]:
            raise DomainError("end_date must not be before due_date")
    category_id = values.get("category_id")
    if category_id is not None and db.get(Category, category_id) is None:
        raise DomainError(f"Unknown category_id {category_id}")
    tx_id = values.get("fulfilled_transaction_id")
    if tx_id is not None and db.get(Transaction, tx_id) is None:
        raise DomainError(f"Unknown fulfilled_transaction_id {tx_id}")


def list_manual_entries(db: Session) -> list[ManualEntry]:
    return list(db.scalars(select(ManualEntry).order_by(ManualEntry.due_date, ManualEntry.id)))


def get_manual_entry(db: Session, entry_id: int) -> ManualEntry:
    entry = db.get(ManualEntry, entry_id)
    if entry is None:
        raise NotFoundError(f"Manual entry {entry_id} not found")
    return entry


def create_manual_entry(db: Session, body: ManualEntryCreate) -> ManualEntry:
    values = body.model_dump()
    _validate(db, values)
    entry = ManualEntry(**values)
    db.add(entry)
    db.commit()
    return entry


def update_manual_entry(db: Session, entry_id: int, body: ManualEntryUpdate) -> ManualEntry:
    entry = get_manual_entry(db, entry_id)
    changes = body.model_dump(exclude_unset=True)
    for name in _REQUIRED:
        if name in changes and changes[name] is None:
            raise DomainError(f"{name} cannot be null")
    merged = {
        "amount": entry.amount,
        "description": entry.description,
        "category_id": entry.category_id,
        "due_date": entry.due_date,
        "recurrence": entry.recurrence,
        "end_date": entry.end_date,
        "fulfilled_transaction_id": entry.fulfilled_transaction_id,
        **changes,
    }
    _validate(db, merged)
    for name, value in changes.items():
        setattr(entry, name, value)
    db.commit()
    return entry


def delete_manual_entry(db: Session, entry_id: int) -> None:
    db.delete(get_manual_entry(db, entry_id))
    db.commit()
