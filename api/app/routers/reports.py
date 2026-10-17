"""Owned by Wave 2 insight brief."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Path, Query

from app.deps import DbSession
from app.models.base import EssentialityFilter
from app.schemas.month import MonthDetail
from app.schemas.reports import AccountBalanceSeries, CategoryTotal, MonthlySummary
from app.services import reports as service

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/monthly", response_model=list[MonthlySummary])
def get_monthly_summary(
    db: DbSession, months: int = Query(12, ge=1, le=60)
) -> list[MonthlySummary]:
    return service.monthly_summary(db, months)


@router.get("/month/{month}", response_model=MonthDetail)
def get_month_detail(
    db: DbSession, month: Annotated[str, Path(pattern=r"^\d{4}-\d{2}$")]
) -> MonthDetail:
    """One month in detail: totals vs recent average, essentiality, categories, largest."""
    return service.month_detail(db, month)


@router.get("/by-category", response_model=list[CategoryTotal])
def get_spending_by_category(
    db: DbSession,
    month: Annotated[str, Query(pattern=r"^\d{4}-\d{2}$")],
    essentiality: EssentialityFilter | None = None,
) -> list[CategoryTotal]:
    return service.spending_by_category(db, month, essentiality)


@router.get("/balances", response_model=list[AccountBalanceSeries])
def get_balance_history(
    db: DbSession, start: date | None = None, end: date | None = None
) -> list[AccountBalanceSeries]:
    return service.balance_history(db, start, end)
