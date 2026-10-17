from datetime import datetime

from sqlalchemy import CHAR, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import AccountType, Base, Money, TimestampMixin, str_enum


class Account(TimestampMixin, Base):
    __tablename__ = "accounts"
    __table_args__ = (UniqueConstraint("provider", "external_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(20))
    external_id: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(255))
    type: Mapped[AccountType] = mapped_column(str_enum(AccountType), default=AccountType.OTHER)
    institution_name: Mapped[str | None] = mapped_column(String(255))
    currency: Mapped[str] = mapped_column(CHAR(3), default="USD")
    is_active: Mapped[bool] = mapped_column(default=True)

    balances: Mapped[list[BalanceSnapshot]] = relationship(back_populates="account")


class BalanceSnapshot(Base):
    __tablename__ = "balance_snapshots"
    __table_args__ = (Index("ix_balance_snapshots_account_as_of", "account_id", "as_of"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"))
    balance: Mapped[Money]
    available: Mapped[Money | None]
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    account: Mapped[Account] = relationship(back_populates="balances")
