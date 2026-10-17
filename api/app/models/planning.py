from datetime import date

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import (
    Base,
    Cadence,
    Essentiality,
    Money,
    Recurrence,
    RecurrenceStatus,
    SuggestionStatus,
    TimestampMixin,
    str_enum,
)


class ManualEntry(TimestampMixin, Base):
    """Expected income (positive) or expense (negative) not yet in bank data."""

    __tablename__ = "manual_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    amount: Mapped[Money]
    description: Mapped[str] = mapped_column(String(255))
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"))
    due_date: Mapped[date]
    recurrence: Mapped[Recurrence] = mapped_column(str_enum(Recurrence), default=Recurrence.NONE)
    end_date: Mapped[date | None]
    fulfilled_transaction_id: Mapped[int | None] = mapped_column(
        ForeignKey("transactions.id", ondelete="SET NULL")
    )


class RecurringCharge(TimestampMixin, Base):
    """A detected or confirmed recurring income or expense. Table name per ARCHITECTURE.md."""

    __tablename__ = "recurrences"
    __table_args__ = (UniqueConstraint("merchant_key", "account_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    merchant_key: Mapped[str] = mapped_column(String(255))
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"))
    amount: Mapped[Money]
    cadence: Mapped[Cadence] = mapped_column(str_enum(Cadence))
    next_expected_date: Mapped[date]
    last_seen_on: Mapped[date | None]
    status: Mapped[RecurrenceStatus] = mapped_column(
        str_enum(RecurrenceStatus), default=RecurrenceStatus.PROPOSED
    )
    essentiality: Mapped[Essentiality | None] = mapped_column(str_enum(Essentiality))


class Goal(TimestampMixin, Base):
    """v1 goal type: save target_amount by target_date."""

    __tablename__ = "goals"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    target_amount: Mapped[Money]
    target_date: Mapped[date]
    starting_amount: Mapped[Money]
    is_active: Mapped[bool] = mapped_column(default=True)


class Suggestion(TimestampMixin, Base):
    __tablename__ = "suggestions"

    id: Mapped[int] = mapped_column(primary_key=True)
    goal_id: Mapped[int] = mapped_column(ForeignKey("goals.id", ondelete="CASCADE"))
    text: Mapped[str] = mapped_column(Text)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"))
    estimated_monthly_saving: Mapped[Money | None]
    status: Mapped[SuggestionStatus] = mapped_column(
        str_enum(SuggestionStatus), default=SuggestionStatus.OPEN
    )
