from datetime import date, datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    false,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import (
    Base,
    ClassificationSource,
    Confidence,
    Essentiality,
    Money,
    TimestampMixin,
    str_enum,
)


class Transaction(TimestampMixin, Base):
    """Amount sign: negative is money leaving the account, positive is money arriving."""

    __tablename__ = "transactions"
    __table_args__ = (
        UniqueConstraint("account_id", "external_id"),
        Index("ix_transactions_posted_on", "posted_on"),
        Index("ix_transactions_merchant_key", "merchant_key"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"))
    external_id: Mapped[str] = mapped_column(String(255))
    posted_on: Mapped[date]
    transacted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    amount: Mapped[Money]
    raw_description: Mapped[str] = mapped_column(Text)
    payee: Mapped[str | None] = mapped_column(Text)
    memo: Mapped[str | None] = mapped_column(Text)
    pending: Mapped[bool] = mapped_column(default=False)
    merchant_key: Mapped[str | None] = mapped_column(String(255))
    # The owner's own free-text context, e.g. "Therapy, September sessions". Never sent to an LLM.
    note: Mapped[str | None] = mapped_column(Text)
    # Owner-marked one-off (a fine, a big medical bill): still spending, but left out of the
    # trailing average that drives the projection.
    one_time: Mapped[bool] = mapped_column(default=False, server_default=false())
    is_transfer: Mapped[bool] = mapped_column(default=False)
    transfer_pair_id: Mapped[int | None] = mapped_column(
        ForeignKey("transactions.id", ondelete="SET NULL")
    )

    categorization: Mapped[Categorization | None] = relationship(
        back_populates="transaction", uselist=False
    )


class Categorization(Base):
    __tablename__ = "categorizations"

    transaction_id: Mapped[int] = mapped_column(
        ForeignKey("transactions.id", ondelete="CASCADE"), primary_key=True
    )
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"))
    essentiality: Mapped[Essentiality | None] = mapped_column(str_enum(Essentiality))
    source: Mapped[ClassificationSource] = mapped_column(str_enum(ClassificationSource))
    confidence: Mapped[Confidence] = mapped_column(str_enum(Confidence), default=Confidence.UNKNOWN)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    transaction: Mapped[Transaction] = relationship(back_populates="categorization")
