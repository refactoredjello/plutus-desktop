"""What changed (R12): signals about the current month, and their dismissals."""

from fastapi import APIRouter, status

from app.deps import DbSession
from app.schemas.changes import ChangesRead, DismissChange
from app.services import changes as service
from app.services import schedule

router = APIRouter(prefix="/reports/changes", tags=["changes"])


@router.get("", response_model=ChangesRead)
def get_changes(db: DbSession, all: bool = False) -> ChangesRead:
    """Up to seven items; `all=true` returns every item so the card can expand in place."""
    return service.compute(db, schedule.today(), include_all=all)


@router.post("/dismiss", status_code=status.HTTP_204_NO_CONTENT)
def dismiss_change(body: DismissChange, db: DbSession) -> None:
    service.dismiss(db, body.key)


@router.delete("/dismissals", status_code=status.HTTP_204_NO_CONTENT)
def clear_change_dismissals(db: DbSession) -> None:
    service.clear_dismissals(db)
