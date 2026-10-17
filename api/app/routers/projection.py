"""Owned by Wave 2 insight brief."""

from fastapi import APIRouter, Query

from app.deps import DbSession
from app.schemas.projection import ProjectionRead
from app.services import projection as service

router = APIRouter(prefix="/projection", tags=["projection"])


@router.get("", response_model=ProjectionRead)
def get_projection(db: DbSession, months: int = Query(3, ge=1, le=12)) -> ProjectionRead:
    return service.project(db, months)
