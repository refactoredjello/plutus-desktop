"""Deterministic LLM stand-in for tests and credential-free development.

Records every call so privacy tests can assert on exactly what would have been sent.
"""

from decimal import Decimal

from app.models.base import Confidence, Essentiality
from app.providers.llm.base import (
    MerchantClassification,
    MerchantInput,
    SavingsContext,
    SavingsSuggestion,
)

_KEYWORDS: list[tuple[str, str, Essentiality]] = [
    ("PAYROLL", "INCOME_SALARY", Essentiality.ESSENTIAL),
    ("COFFEE", "FOOD_AND_DRINK_COFFEE", Essentiality.DISCRETIONARY),
    ("NETFLIX", "ENTERTAINMENT_TV_AND_MOVIES", Essentiality.DISCRETIONARY),
    ("SPOTIFY", "ENTERTAINMENT_MUSIC_AND_AUDIO", Essentiality.DISCRETIONARY),
    ("GROCER", "FOOD_AND_DRINK_GROCERIES", Essentiality.ESSENTIAL),
    ("MARKET", "FOOD_AND_DRINK_GROCERIES", Essentiality.ESSENTIAL),
    ("RENT", "RENT_AND_UTILITIES_RENT", Essentiality.ESSENTIAL),
    ("ELECTRIC", "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY", Essentiality.ESSENTIAL),
    ("SHELL", "TRANSPORTATION_GAS", Essentiality.ESSENTIAL),
    ("AMAZON", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", Essentiality.FLEXIBLE),
    ("RESTAURANT", "FOOD_AND_DRINK_RESTAURANT", Essentiality.DISCRETIONARY),
]


class FakeLLMProvider:
    name = "fake"

    def __init__(self) -> None:
        self.classify_calls: list[list[MerchantInput]] = []
        self.suggest_calls: list[SavingsContext] = []

    def classify_merchants(self, items: list[MerchantInput]) -> list[MerchantClassification]:
        self.classify_calls.append(list(items))
        results = []
        for item in items:
            match = next((k for k in _KEYWORDS if k[0] in item.merchant_key), None)
            if match:
                results.append(
                    MerchantClassification(item.merchant_key, match[1], match[2], Confidence.HIGH)
                )
            else:
                results.append(
                    MerchantClassification(
                        item.merchant_key,
                        "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE",
                        Essentiality.FLEXIBLE,
                        Confidence.LOW,
                    )
                )
        return results

    def suggest_savings(self, context: SavingsContext) -> list[SavingsSuggestion]:
        self.suggest_calls.append(context)
        out = []
        for rec in context.recurring:
            if rec.essentiality is Essentiality.DISCRETIONARY:
                text = f"Review your {rec.category_label} subscription ({rec.cadence})."
                if text not in context.excluded_suggestions:
                    out.append(SavingsSuggestion(text, rec.category_label, rec.amount))
        if not out:
            out.append(SavingsSuggestion("Set a weekly cap on dining out.", None, Decimal("50.00")))
        return out
