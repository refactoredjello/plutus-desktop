"""LLM provider interface.

Privacy invariant: inputs to these methods are built only by services/scrub.py and
services/suggestions.py. Providers must never receive raw descriptions, balances,
account names, or the owner's name.
"""

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal, Protocol

from app.models.base import Confidence, Essentiality

AmountBucket = Literal["<10", "10-50", "50-200", "200-1000", ">1000"]
AccountKind = Literal["checking", "savings", "credit", "loan", "other"]


@dataclass(frozen=True)
class MerchantInput:
    merchant_key: str  # scrubbed, normalized
    amount_bucket: AmountBucket
    direction: Literal["inflow", "outflow"]
    account_kind: AccountKind


@dataclass(frozen=True)
class MerchantClassification:
    merchant_key: str
    detailed_category: str  # a Plaid detailed category, e.g. FOOD_AND_DRINK_COFFEE
    essentiality: Essentiality
    confidence: Confidence


@dataclass(frozen=True)
class CategorySpend:
    label: str
    monthly_totals: list[Decimal]  # oldest first


@dataclass(frozen=True)
class RecurringSpend:
    category_label: str  # merchant names are withheld
    amount: Decimal
    cadence: str
    essentiality: Essentiality


@dataclass(frozen=True)
class SavingsContext:
    goal_target: Decimal
    months_left: int
    monthly_gap: Decimal  # extra saving needed per month; <= 0 means on track
    categories: list[CategorySpend]
    recurring: list[RecurringSpend]
    excluded_suggestions: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class SavingsSuggestion:
    text: str
    category_label: str | None
    estimated_monthly_saving: Decimal | None


class LLMProvider(Protocol):
    name: str

    def classify_merchants(self, items: list[MerchantInput]) -> list[MerchantClassification]: ...

    def suggest_savings(self, context: SavingsContext) -> list[SavingsSuggestion]: ...
