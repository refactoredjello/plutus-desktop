"""Owned by Wave 1 categorization brief."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import AppSettings, DbSession
from app.models.base import EssentialityFilter
from app.schemas.common import Page
from app.schemas.transactions import TransactionRead, TransactionUpdate
from app.services import transactions as service

router = APIRouter(prefix="/transactions", tags=["transactions"])


@router.get("", response_model=Page[TransactionRead])
def list_transactions(
    db: DbSession,
    q: str | None = None,
    start: date | None = None,
    end: date | None = None,
    account_id: Annotated[list[int] | None, Query()] = None,
    category_id: Annotated[list[int] | None, Query()] = None,
    essentiality: EssentialityFilter | None = None,
    uncategorized: bool = False,
    needs_review: bool = False,
    include_transfers: bool = False,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> Page[TransactionRead]:
    rows, total = service.list_transactions(
        db,
        q=q,
        start=start,
        end=end,
        account_ids=account_id,
        category_ids=category_id,
        essentiality=essentiality,
        uncategorized=uncategorized,
        needs_review=needs_review,
        include_transfers=include_transfers,
        limit=limit,
        offset=offset,
    )
    return Page(
        items=[TransactionRead.model_validate(r) for r in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.patch("/{transaction_id}", response_model=TransactionRead)
def update_transaction(
    transaction_id: int, body: TransactionUpdate, db: DbSession, settings: AppSettings
) -> TransactionRead:
    tx = service.update_transaction(db, settings, transaction_id, body)
    return TransactionRead.model_validate(tx)
