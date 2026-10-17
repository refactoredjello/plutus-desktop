"""Prompts and structured-output models shared by the LLM providers.

System prompts are built only from static data (the seeded taxonomy and fixed text), so they
are byte-identical across calls and Anthropic prompt caching can reuse them. Anything that
varies per call goes in the user message.
"""

import csv
import json
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel

from app.models.base import Confidence, Essentiality
from app.providers.llm.base import (
    MerchantClassification,
    MerchantInput,
    SavingsContext,
    SavingsSuggestion,
)

SEED = Path(__file__).parents[2] / "seed" / "plaid_pfc_v2.csv"
_ACRONYMS = {"Tv": "TV", "Atm": "ATM"}


class ClassifiedMerchant(BaseModel):
    merchant_key: str
    detailed_category: str
    essentiality: Essentiality
    confidence: Confidence


class ClassificationBatch(BaseModel):
    items: list[ClassifiedMerchant]


class SuggestedSaving(BaseModel):
    text: str
    category_label: str | None
    estimated_monthly_saving: float | None


class SuggestionBatch(BaseModel):
    suggestions: list[SuggestedSaving]


def _label_for(primary: str, detailed: str) -> str:
    """Same labelling as migration 0002: FOOD_AND_DRINK_COFFEE -> 'Coffee'."""
    words = detailed.removeprefix(primary + "_").lower().split("_")
    words[0] = words[0].capitalize()
    return " ".join(_ACRONYMS.get(w.capitalize(), w) for w in words)


@lru_cache
def taxonomy_text() -> str:
    """The seeded taxonomy, one line per detailed category, sorted deterministically."""
    with SEED.open(encoding="utf-8") as f:
        rows = sorted(csv.DictReader(f), key=lambda r: (r["primary"], r["detailed"]))
    lines = []
    for r in rows:
        description = " ".join((r["description"] or "No further description.").split())
        lines.append(
            f"- {r['detailed']} | {_label_for(r['primary'], r['detailed'])} | {description}"
        )
    return "\n".join(lines)


_CLASSIFY_INSTRUCTIONS = """\
You classify bank-transaction merchants for a personal finance app. Each input describes one
merchant by a scrubbed, normalized merchant key (uppercase, no account numbers, dates,
reference ids or personal names), a coarse amount bucket, a direction (inflow means money
arriving, outflow means money leaving) and the kind of account it posted to. For every input,
choose exactly one detailed category from the taxonomy below and one essentiality label.

How to work:
- Copy merchant_key into the output exactly as given, character for character. Return one
  output item per input item, in the same order, with no extras and none missing.
- detailed_category must be one of the detailed names in the taxonomy, spelled exactly as
  listed (uppercase with underscores). Never invent a category. If nothing fits, use
  OTHER_OTHER and set confidence to low.
- Use the direction. Money arriving from an employer is INCOME_*; money arriving as a refund
  or reimbursement is usually TRANSFER_IN_* or the original spending category. Outflows are
  spending, bill payments or transfers.
- Use the account kind. A payment to a credit or loan account from checking is a transfer or
  loan payment; a charge on a credit account is ordinary spending.
- Keys such as ZELLE TO, ZELLE FROM or VENMO PAYMENT have had the counterparty removed on
  purpose. Classify them as person-to-person transfers (TRANSFER_OUT_TRANSFER_OUT_FROM_APPS,
  TRANSFER_IN_TRANSFER_IN_FROM_APPS or the account-transfer variants) and use low confidence,
  because the purpose is unknown.
- Prefer the most specific detailed category that clearly applies; fall back to a broader
  "other" category inside the right primary group when the specific one is uncertain.
- The amount bucket is a hint only. It never overrides what the merchant obviously is.

Confidence:
- very_high: a well-known merchant whose category is unambiguous.
- high: clear from the name, with small room for doubt.
- medium: a plausible reading, but the merchant could belong to another category.
- low: a guess from weak evidence. Low confidence flags the result for human review, so use
  it honestly rather than guessing with false certainty.

Essentiality, which tells the owner what could be cut to save money:
- essential: needed to live or work, and not realistically avoidable. Examples: rent or
  mortgage, utilities, basic groceries, health care, insurance, minimum debt payments,
  commuting, childcare, payroll and other income.
- flexible: needed in some form, but the amount could be lower by shopping around or
  changing habits. Examples: phone and internet plans, gas beyond commuting, household goods,
  clothing, pharmacy items, car maintenance, gym memberships used regularly.
- discretionary: could be cut without harming daily life. Examples: restaurants, coffee
  shops, bars, streaming and music subscriptions, entertainment, hobbies, travel, gifts,
  most online shopping.
Money-in and pure transfers (INCOME_*, TRANSFER_IN_*, TRANSFER_OUT_*) are essential by
convention, because they are not spending that can be trimmed.

Worked examples (merchant key, direction, account kind -> category, essentiality, confidence):
- BLUE BOTTLE COFFEE OAKLAND CA, outflow, credit -> FOOD_AND_DRINK_COFFEE, discretionary, high
- TRADER JOE S OAKLAND CA, outflow, credit -> FOOD_AND_DRINK_GROCERIES, essential, very_high
- NETFLIX.COM CA, outflow, credit -> ENTERTAINMENT_TV_AND_MOVIES, discretionary, very_high
- ACME CORP PAYROLL, inflow, checking -> INCOME_SALARY, essential, high
- PG&E WEB ONLINE, outflow, checking -> RENT_AND_UTILITIES_GAS_AND_ELECTRICITY, essential, high
- AMZN MKTP US, outflow, credit -> GENERAL_MERCHANDISE_ONLINE_MARKETPLACES, flexible, medium
- ZELLE TO, outflow, checking -> TRANSFER_OUT_TRANSFER_OUT_FROM_APPS, essential, low
- UNRECOGNIZABLE MERCHANT NAME, outflow, credit -> OTHER_OTHER, flexible, low

Taxonomy. Each line is: detailed name | label | description.
"""

_SAVINGS_INSTRUCTIONS = """\
You help one person save toward a financial goal. You receive aggregated spending data only:
monthly totals per category (oldest month first), recurring charges described by category and
cadence with an essentiality label, the goal target, the months left and the monthly gap that
must still be saved. Merchant names, account names and personal details are never provided,
and you must not guess or invent them.

Essentiality labels: essential means needed to live or work; flexible means needed but could
be made cheaper; discretionary means could be cut.

Rules:
- Ground every suggestion in the numbers provided. Refer to categories by their label and to
  amounts as dollars per month. Do not cite figures that are not in the input.
- Favor discretionary and flexible spending. Never suggest cutting essential spending, except
  to compare prices for the same service.
- Each suggestion is one or two sentences, specific and actionable, and states a realistic
  estimated monthly saving in dollars when the data supports one; otherwise leave it empty.
- category_label must be one of the provided category labels, or empty if the suggestion
  spans several categories.
- Do not repeat or rephrase any suggestion listed under excluded_suggestions; the owner has
  already dismissed those.
- If the monthly gap is zero or negative, the goal is on track: say so briefly and give at
  most one optional idea. Otherwise return between 3 and 6 suggestions, highest saving first.
"""


def classify_system_prompt() -> str:
    return _CLASSIFY_INSTRUCTIONS + taxonomy_text()


def savings_system_prompt() -> str:
    return _SAVINGS_INSTRUCTIONS


# Rendered without 4+ digit runs so that nothing in a payload resembles an account number.
_BUCKET_TEXT = {
    "<10": "under $10",
    "10-50": "$10 to $50",
    "50-200": "$50 to $200",
    "200-1000": "$200 to $1k",
    ">1000": "over $1k",
}


def classify_user_message(items: list[MerchantInput]) -> str:
    payload = [
        {
            "merchant_key": i.merchant_key,
            "amount_bucket": _BUCKET_TEXT[i.amount_bucket],
            "direction": i.direction,
            "account_kind": i.account_kind,
        }
        for i in items
    ]
    return "Classify these merchants:\n" + json.dumps(payload, indent=1)


def savings_user_message(context: SavingsContext) -> str:
    payload = {
        "goal_target": str(context.goal_target),
        "months_left": context.months_left,
        "monthly_gap": str(context.monthly_gap),
        "categories": [
            {"label": c.label, "monthly_totals": [str(t) for t in c.monthly_totals]}
            for c in context.categories
        ],
        "recurring": [
            {
                "category_label": r.category_label,
                "amount": str(r.amount),
                "cadence": r.cadence,
                "essentiality": r.essentiality.value,
            }
            for r in context.recurring
        ],
        "excluded_suggestions": list(context.excluded_suggestions),
    }
    return "Suggest savings for this situation:\n" + json.dumps(payload, indent=1)


def to_classifications(batch: ClassificationBatch) -> list[MerchantClassification]:
    return [
        MerchantClassification(
            merchant_key=i.merchant_key,
            detailed_category=i.detailed_category,
            essentiality=i.essentiality,
            confidence=i.confidence,
        )
        for i in batch.items
    ]


def to_suggestions(batch: SuggestionBatch) -> list[SavingsSuggestion]:
    return [
        SavingsSuggestion(
            text=s.text,
            category_label=s.category_label,
            estimated_monthly_saving=(
                None
                if s.estimated_monthly_saving is None
                else Decimal(str(round(s.estimated_monthly_saving, 2)))
            ),
        )
        for s in batch.suggestions
    ]
