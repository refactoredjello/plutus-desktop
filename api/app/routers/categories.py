"""Owned by Wave 1 categorization brief."""

from fastapi import APIRouter, status

from app.deps import DbSession
from app.schemas.categories import CategoryCreate, CategoryRead, CategoryUpdate, RuleRead
from app.services import categories as service

router = APIRouter(tags=["categories"])


@router.get("/categories", response_model=list[CategoryRead])
def list_categories(db: DbSession, include_hidden: bool = False) -> list[CategoryRead]:
    return [CategoryRead.model_validate(c) for c in service.list_categories(db, include_hidden)]


@router.post("/categories", response_model=CategoryRead, status_code=status.HTTP_201_CREATED)
def create_category(body: CategoryCreate, db: DbSession) -> CategoryRead:
    return CategoryRead.model_validate(service.create_category(db, body))


@router.patch("/categories/{category_id}", response_model=CategoryRead)
def update_category(category_id: int, body: CategoryUpdate, db: DbSession) -> CategoryRead:
    return CategoryRead.model_validate(service.update_category(db, category_id, body))


@router.get("/rules", response_model=list[RuleRead])
def list_rules(db: DbSession) -> list[RuleRead]:
    return [RuleRead.model_validate(r) for r in service.list_rules(db)]


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rule(rule_id: int, db: DbSession) -> None:
    service.delete_rule(db, rule_id)
