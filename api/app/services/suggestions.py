"""Savings suggestions (R8). Privacy boundary: the LLM sees only what this module builds.

The SavingsContext holds category labels, rounded-to-cent monthly totals, cadences,
and goal numbers. Never merchant keys, descriptions, account names, or balances.
"""

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.errors import NotFoundError
from app.models import (
    Categorization,
    Category,
    Goal,
    MerchantClassification,
    RecurringCharge,
    Suggestion,
    Transaction,
)
from app.models.base import Essentiality, RecurrenceStatus, SuggestionStatus
from app.providers.llm import get_llm_provider
from app.providers.llm.base import CategorySpend, LLMProvider, RecurringSpend, SavingsContext
from app.services import goals as goals_service
from app.services.aggregates import ZERO, category_totals

TOP_CATEGORIES = 15
HISTORY_MONTHS = 6
_SUGGESTIBLE = (Essentiality.FLEXIBLE, Essentiality.DISCRETIONARY)
UNCATEGORIZED = "Uncategorized"


def _merchant_label(db: Session, merchant_key: str) -> str:
    """Category label for a merchant: cache first, else its latest categorized transaction."""
    label = db.scalar(
        select(Category.label)
        .join(MerchantClassification, MerchantClassification.category_id == Category.id)
        .where(MerchantClassification.merchant_key == merchant_key)
    )
    if label is None:
        label = db.scalar(
            select(Category.label)
            .join(Categorization, Categorization.category_id == Category.id)
            .join(Transaction, Transaction.id == Categorization.transaction_id)
            .where(Transaction.merchant_key == merchant_key)
            .order_by(Transaction.posted_on.desc(), Transaction.id.desc())
            .limit(1)
        )
    return label or UNCATEGORIZED


def build_context(db: Session, goal: Goal) -> SavingsContext:
    months = goals_service.previous_complete_months(HISTORY_MONTHS)
    spend = [c for c in category_totals(db, months) if c.category_id is not None]
    categories = [
        CategorySpend(c.label, [c.monthly.get(m, ZERO) for m in months])
        for c in spend[:TOP_CATEGORIES]
    ]

    charges = db.scalars(
        select(RecurringCharge)
        .where(
            RecurringCharge.status == RecurrenceStatus.CONFIRMED,
            RecurringCharge.essentiality.in_(_SUGGESTIBLE),
        )
        .order_by(RecurringCharge.id)
    )
    recurring = [
        RecurringSpend(
            category_label=_merchant_label(db, r.merchant_key),
            amount=abs(r.amount),
            cadence=r.cadence.value,
            essentiality=r.essentiality,
        )
        for r in charges
        if r.essentiality is not None
    ]

    progress = goals_service.compute_progress(db, goal)
    excluded = list(
        db.scalars(
            select(Suggestion.text)
            .where(Suggestion.goal_id == goal.id, Suggestion.status == SuggestionStatus.DISMISSED)
            .order_by(Suggestion.id)
        )
    )
    return SavingsContext(
        goal_target=goal.target_amount,
        months_left=progress.months_left,
        monthly_gap=progress.required_monthly - progress.actual_monthly_average,
        categories=categories,
        recurring=recurring,
        excluded_suggestions=excluded,
    )


def list_suggestions(db: Session, goal_id: int) -> list[Suggestion]:
    goals_service.get_goal(db, goal_id)
    stmt = (
        select(Suggestion)
        .where(Suggestion.goal_id == goal_id)
        .order_by(Suggestion.created_at.desc(), Suggestion.id.desc())
    )
    return list(db.scalars(stmt))


def generate_suggestions(
    db: Session, goal_id: int, settings: Settings, provider: LLMProvider | None = None
) -> list[Suggestion]:
    """Ask the LLM for suggestions. ProviderError propagates; nothing is stored then."""
    goal = goals_service.get_goal(db, goal_id)
    llm = provider or get_llm_provider(settings)
    results = llm.suggest_savings(build_context(db, goal))
    category_ids: dict[str, int] = {}
    for cat_id, label in db.execute(
        select(Category.id, Category.label).order_by(Category.id.desc())
    ):
        category_ids[label] = cat_id
    created = [
        Suggestion(
            goal_id=goal.id,
            text=r.text,
            category_id=category_ids.get(r.category_label) if r.category_label else None,
            estimated_monthly_saving=(
                Decimal(r.estimated_monthly_saving).quantize(ZERO)
                if r.estimated_monthly_saving is not None
                else None
            ),
        )
        for r in results
    ]
    db.add_all(created)
    db.commit()
    return created


def update_suggestion(db: Session, suggestion_id: int, status: SuggestionStatus) -> Suggestion:
    suggestion = db.get(Suggestion, suggestion_id)
    if suggestion is None:
        raise NotFoundError(f"Suggestion {suggestion_id} not found")
    suggestion.status = status
    db.commit()
    return suggestion
