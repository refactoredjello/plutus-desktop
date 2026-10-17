from datetime import date

from pydantic import Field

from app.models.base import (
    ClassificationSource,
    Confidence,
    Essentiality,
    RuleMatchType,
)
from app.schemas.common import Money, ReadSchema, Schema


class CategorizationRead(ReadSchema):
    category_id: int
    essentiality: Essentiality | None
    source: ClassificationSource
    confidence: Confidence


class TransactionRead(ReadSchema):
    id: int
    account_id: int
    posted_on: date
    amount: Money
    raw_description: str
    payee: str | None
    pending: bool
    merchant_key: str | None
    note: str | None
    one_time: bool
    is_transfer: bool
    categorization: CategorizationRead | None


class TransactionUpdate(Schema):
    """Manual override. Setting save_as_rule also creates a rule for the merchant key."""

    category_id: int | None = None
    essentiality: Essentiality | None = None
    note: str | None = Field(default=None, max_length=500)  # send "" or null to clear
    one_time: bool | None = None  # excluded from the projection's trailing average
    save_as_rule: bool = False
    rule_match_type: RuleMatchType = RuleMatchType.EXACT
