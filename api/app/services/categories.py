"""Category and rule management (R3.1, R2.3)."""

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import ConflictError, DomainError, NotFoundError
from app.models import Category, Rule
from app.schemas.categories import CategoryCreate, CategoryUpdate

_MAX_SLUG = 90  # detailed is VARCHAR(100) and carries a "CUSTOM_" prefix


def _slug(text: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", text.upper()).strip("_")[:_MAX_SLUG].strip("_")


def list_categories(db: Session, include_hidden: bool) -> list[Category]:
    stmt = select(Category).order_by(Category.primary, Category.detailed)
    if not include_hidden:
        stmt = stmt.where(Category.is_hidden.is_(False))
    return list(db.scalars(stmt))


def create_category(db: Session, body: CategoryCreate) -> Category:
    primary, label = _slug(body.primary), body.label.strip()
    slug = _slug(label)
    if not primary or not slug:
        raise DomainError("Primary and label must contain letters or digits")
    detailed = f"CUSTOM_{slug}"
    if db.scalar(select(Category.id).where(Category.detailed == detailed)) is not None:
        raise ConflictError(f"Category {detailed} already exists")
    category = Category(
        primary=primary,
        detailed=detailed,
        label=label,
        description=body.description,
        is_custom=True,
    )
    db.add(category)
    db.commit()
    return category


def update_category(db: Session, category_id: int, body: CategoryUpdate) -> Category:
    category = db.get(Category, category_id)
    if category is None:
        raise NotFoundError(f"Category {category_id} not found")
    if body.label is not None:
        category.label = body.label.strip()
    if body.is_hidden is not None:
        category.is_hidden = body.is_hidden
    db.commit()
    return category


def list_rules(db: Session) -> list[Rule]:
    return list(db.scalars(select(Rule).order_by(Rule.id)))


def delete_rule(db: Session, rule_id: int) -> None:
    rule = db.get(Rule, rule_id)
    if rule is None:
        raise NotFoundError(f"Rule {rule_id} not found")
    db.delete(rule)
    db.commit()
