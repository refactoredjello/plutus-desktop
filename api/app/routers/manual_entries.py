"""Manual entries (R5)."""

from fastapi import APIRouter, status

from app.deps import DbSession
from app.schemas.manual_entries import ManualEntryCreate, ManualEntryRead, ManualEntryUpdate
from app.services import manual_entries as service

router = APIRouter(prefix="/manual-entries", tags=["manual-entries"])


@router.get("", response_model=list[ManualEntryRead])
def list_manual_entries(db: DbSession) -> list[ManualEntryRead]:
    return [ManualEntryRead.model_validate(e) for e in service.list_manual_entries(db)]


@router.post("", response_model=ManualEntryRead, status_code=status.HTTP_201_CREATED)
def create_manual_entry(body: ManualEntryCreate, db: DbSession) -> ManualEntryRead:
    return ManualEntryRead.model_validate(service.create_manual_entry(db, body))


@router.patch("/{entry_id}", response_model=ManualEntryRead)
def update_manual_entry(entry_id: int, body: ManualEntryUpdate, db: DbSession) -> ManualEntryRead:
    return ManualEntryRead.model_validate(service.update_manual_entry(db, entry_id, body))


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_manual_entry(entry_id: int, db: DbSession) -> None:
    service.delete_manual_entry(db, entry_id)
