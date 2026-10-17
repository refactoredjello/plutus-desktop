"""Transaction queries and manual overrides (R2.1-R2.3)."""

from datetime import UTC, date, datetime

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.config import Settings
from app.errors import DomainError, NotFoundError
from app.models import Categorization, Category, MerchantClassification, Rule, Transaction
from app.models.base import (
    ClassificationSource,
    Confidence,
    Essentiality,
    EssentialityFilter,
    RuleMatchType,
)
from app.schemas.transactions import TransactionUpdate
from app.services.aggregates import essentiality_condition
from app.services.categorize import apply_rule
from app.services.scrub import merchant_key as scrub_merchant_key


def list_transactions(
    db: Session,
    *,
    q: str | None,
    start: date | None,
    end: date | None,
    account_ids: list[int] | None,
    category_ids: list[int] | None,
    essentiality: EssentialityFilter | None,
    uncategorized: bool,
    needs_review: bool,
    include_transfers: bool,
    limit: int,
    offset: int,
) -> tuple[list[Transaction], int]:
    """Filtered transactions, newest first, plus the total matching count."""
    stmt = select(Transaction).outerjoin(Transaction.categorization)
    if q:
        stmt = stmt.where(
            or_(
                Transaction.raw_description.icontains(q, autoescape=True),
                Transaction.payee.icontains(q, autoescape=True),
                Transaction.note.icontains(q, autoescape=True),
            )
        )
    if start:
        stmt = stmt.where(Transaction.posted_on >= start)
    if end:
        stmt = stmt.where(Transaction.posted_on <= end)
    if account_ids:
        stmt = stmt.where(Transaction.account_id.in_(account_ids))
    if category_ids:
        stmt = stmt.where(Categorization.category_id.in_(category_ids))
    if essentiality:
        stmt = stmt.where(essentiality_condition(essentiality))
    if uncategorized:
        stmt = stmt.where(Categorization.transaction_id.is_(None))
    if needs_review:
        stmt = stmt.where(
            or_(
                Categorization.transaction_id.is_(None),
                Categorization.confidence.in_([Confidence.LOW, Confidence.UNKNOWN]),
            )
        )
    if not include_transfers:
        stmt = stmt.where(Transaction.is_transfer.is_(False))

    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(
        stmt.options(selectinload(Transaction.categorization))
        .order_by(Transaction.posted_on.desc(), Transaction.id.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return list(rows), total


def update_transaction(
    db: Session, settings: Settings, transaction_id: int, body: TransactionUpdate
) -> Transaction:
    """Manual override of category and/or essentiality; optionally saved as a rule. Commits."""
    tx = db.get(Transaction, transaction_id)
    if tx is None:
        raise NotFoundError(f"Transaction {transaction_id} not found")

    fields = body.model_fields_set
    if "note" in fields:
        tx.note = (body.note or "").strip() or None
    if body.one_time is not None:
        tx.one_time = body.one_time

    category_changes = body.category_id is not None or "essentiality" in fields or body.save_as_rule
    # A note- or one-time-only edit leaves the categorization alone.
    if category_changes or not fields <= {"note", "one_time"}:
        _override_category(db, settings, tx, body)

    db.commit()
    return tx


def _override_category(
    db: Session, settings: Settings, tx: Transaction, body: TransactionUpdate
) -> None:
    current = tx.categorization
    if body.category_id is not None:
        if db.get(Category, body.category_id) is None:
            raise DomainError(f"Unknown category {body.category_id}")
        category_id = body.category_id
    elif current is not None:
        category_id = current.category_id
    else:
        raise DomainError("category_id is required for a transaction without a category")

    if "essentiality" in body.model_fields_set:
        essentiality = body.essentiality
    else:
        essentiality = current.essentiality if current else None

    if current is None:
        current = Categorization()
        tx.categorization = current
    current.category_id = category_id
    current.essentiality = essentiality
    current.source = ClassificationSource.MANUAL
    current.confidence = Confidence.VERY_HIGH
    current.updated_at = datetime.now(UTC)

    if body.save_as_rule:
        key = tx.merchant_key or scrub_merchant_key(tx.raw_description, settings.owner_name_tokens)
        tx.merchant_key = key
        _save_rule(db, key, body.rule_match_type, category_id, essentiality)


def _save_rule(
    db: Session,
    key: str,
    match_type: RuleMatchType,
    category_id: int,
    essentiality: Essentiality | None,
) -> None:
    rule = db.scalar(select(Rule).where(Rule.match_type == match_type, Rule.pattern == key))
    if rule is None:
        rule = Rule(match_type=match_type, pattern=key)
        db.add(rule)
    rule.category_id = category_id
    rule.essentiality = essentiality

    entry = db.get(MerchantClassification, key)
    if entry is None:
        entry = MerchantClassification(merchant_key=key)
        db.add(entry)
    entry.category_id = category_id
    entry.essentiality = essentiality
    entry.confidence = Confidence.VERY_HIGH
    entry.source = ClassificationSource.MANUAL

    db.flush()
    apply_rule(db, rule)
