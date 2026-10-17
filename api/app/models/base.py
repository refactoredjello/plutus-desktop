"""Declarative base, shared column types, and enums."""

from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Annotated

from sqlalchemy import DateTime, Enum, MetaData, Numeric, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

Money = Annotated[Decimal, mapped_column(Numeric(14, 2))]


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


def str_enum[E: StrEnum](enum_cls: type[E]) -> Enum:
    """Store enums as VARCHAR, not native Postgres enums, so adding values needs no migration."""
    return Enum(
        enum_cls,
        native_enum=False,
        length=20,
        values_callable=lambda e: [m.value for m in e],
        validate_strings=True,
    )


class AccountType(StrEnum):
    CHECKING = "checking"
    SAVINGS = "savings"
    CREDIT = "credit"
    LOAN = "loan"
    OTHER = "other"


class Essentiality(StrEnum):
    ESSENTIAL = "essential"
    FLEXIBLE = "flexible"
    DISCRETIONARY = "discretionary"


class EssentialityFilter(StrEnum):
    """Query filter: one of the essentiality values, or `unset` for none (incl. uncategorized)."""

    ESSENTIAL = "essential"
    FLEXIBLE = "flexible"
    DISCRETIONARY = "discretionary"
    UNSET = "unset"


class ClassificationSource(StrEnum):
    RULE = "rule"
    CACHE = "cache"
    LLM = "llm"
    MANUAL = "manual"


class Confidence(StrEnum):
    """Mirrors Plaid's confidence levels."""

    VERY_HIGH = "very_high"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    UNKNOWN = "unknown"


class RuleMatchType(StrEnum):
    EXACT = "exact"  # merchant_key equals pattern
    PREFIX = "prefix"  # merchant_key starts with pattern
    CONTAINS = "contains"  # raw description contains pattern (local only, never sent to an LLM)


class Cadence(StrEnum):
    WEEKLY = "weekly"
    BIWEEKLY = "biweekly"
    SEMIMONTHLY = "semimonthly"  # twice a month on roughly fixed days, e.g. the 15th and month end
    MONTHLY = "monthly"
    YEARLY = "yearly"


class Recurrence(StrEnum):
    NONE = "none"
    WEEKLY = "weekly"
    BIWEEKLY = "biweekly"
    MONTHLY = "monthly"
    YEARLY = "yearly"


class RecurrenceStatus(StrEnum):
    PROPOSED = "proposed"
    CONFIRMED = "confirmed"
    DISMISSED = "dismissed"


class SuggestionStatus(StrEnum):
    OPEN = "open"
    KEPT = "kept"
    DISMISSED = "dismissed"


class SyncTrigger(StrEnum):
    SCHEDULED = "scheduled"
    MANUAL = "manual"


class SyncStatus(StrEnum):
    RUNNING = "running"
    SUCCESS = "success"
    ERROR = "error"
