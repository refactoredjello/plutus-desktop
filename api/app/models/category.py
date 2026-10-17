from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import (
    Base,
    ClassificationSource,
    Confidence,
    Essentiality,
    RuleMatchType,
    str_enum,
)


class Category(Base):
    """Seeded from Plaid's Personal Finance Categories (primary + detailed)."""

    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    primary: Mapped[str] = mapped_column(String(100))
    detailed: Mapped[str] = mapped_column(String(100), unique=True)
    label: Mapped[str] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(Text)
    is_hidden: Mapped[bool] = mapped_column(default=False)
    is_custom: Mapped[bool] = mapped_column(default=False)


class MerchantClassification(Base):
    """Cache of classifications per normalized merchant key. The LLM is asked once per key."""

    __tablename__ = "merchant_classifications"

    merchant_key: Mapped[str] = mapped_column(String(255), primary_key=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"))
    essentiality: Mapped[Essentiality | None] = mapped_column(str_enum(Essentiality))
    confidence: Mapped[Confidence] = mapped_column(str_enum(Confidence))
    source: Mapped[ClassificationSource] = mapped_column(str_enum(ClassificationSource))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Rule(Base):
    """Owner-defined rules. Always win over cache and LLM."""

    __tablename__ = "rules"
    __table_args__ = (UniqueConstraint("match_type", "pattern"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    match_type: Mapped[RuleMatchType] = mapped_column(str_enum(RuleMatchType))
    pattern: Mapped[str] = mapped_column(String(255))
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"))
    essentiality: Mapped[Essentiality | None] = mapped_column(str_enum(Essentiality))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
