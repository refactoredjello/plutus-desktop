"""Categorization pipeline (R3): rules, then cache, then LLM.

Owned by the Wave 1 categorization brief.

Called by services/sync.py after transfer matching. Keep the signature stable.
"""

from collections.abc import Sequence
from datetime import UTC, datetime
from itertools import batched

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import (
    Account,
    Categorization,
    Category,
    MerchantClassification,
    Rule,
    Transaction,
)
from app.models.base import (
    AccountType,
    ClassificationSource,
    Confidence,
    Essentiality,
    RuleMatchType,
)
from app.providers.llm import get_llm_provider
from app.providers.llm.base import LLMProvider, MerchantInput
from app.providers.llm.base import MerchantClassification as LLMClassification
from app.services.scrub import build_merchant_input, merchant_key

log = structlog.get_logger()

BATCH_SIZE = 50
FALLBACK_CATEGORY = "OTHER_OTHER"


def categorize_pending(db: Session, settings: Settings, provider: LLMProvider | None = None) -> int:
    """Set merchant_key and a categorization on every transaction that lacks one.

    Order: transfers, owner rules (exact, contains, prefix), cached merchant classifications,
    then the LLM for keys never seen before. A failing LLM leaves its transactions
    uncategorized; it never raises.
    Returns the number of transactions categorized. Does not commit.
    """
    pending = db.scalars(
        select(Transaction).where(~Transaction.categorization.has()).order_by(Transaction.id)
    ).all()
    if not pending:
        return 0

    for tx in pending:
        tx.merchant_key = merchant_key(tx.raw_description, settings.owner_name_tokens)

    category_ids = dict(db.execute(select(Category.detailed, Category.id)).all())
    account_types = dict(db.execute(select(Account.id, Account.type)).all())
    pipeline = _Pipeline(db, category_ids)

    unresolved: list[Transaction] = []
    for tx in pending:
        if tx.is_transfer:
            pipeline.assign_transfer(tx, account_types)
        else:
            unresolved.append(tx)

    rules = _Rules(db.scalars(select(Rule)).all())
    after_rules: list[Transaction] = []
    for tx in unresolved:
        rule = rules.match(tx.merchant_key or "", tx.raw_description)
        if rule is None:
            after_rules.append(tx)
        else:
            pipeline.assign(
                tx,
                rule.category_id,
                rule.essentiality,
                ClassificationSource.RULE,
                Confidence.VERY_HIGH,
            )

    keys = sorted({tx.merchant_key for tx in after_rules if tx.merchant_key})
    cache = {
        c.merchant_key: c
        for c in db.scalars(
            select(MerchantClassification).where(MerchantClassification.merchant_key.in_(keys))
        )
    }
    unseen: list[Transaction] = []
    for tx in after_rules:
        entry = cache.get(tx.merchant_key or "")
        if entry is None:
            unseen.append(tx)
        else:
            pipeline.assign(
                tx,
                entry.category_id,
                entry.essentiality,
                ClassificationSource.CACHE,
                entry.confidence,
            )

    if unseen:
        _classify_unseen(db, settings, provider, pipeline, unseen, account_types)

    db.flush()
    return pipeline.count


def _classify_unseen(
    db: Session,
    settings: Settings,
    provider: LLMProvider | None,
    pipeline: _Pipeline,
    unseen: Sequence[Transaction],
    account_types: dict[int, AccountType],
) -> None:
    by_key: dict[str, list[Transaction]] = {}
    for tx in unseen:
        by_key.setdefault(tx.merchant_key or "", []).append(tx)
    inputs = [
        build_merchant_input(
            key, txs[0].amount, account_types.get(txs[0].account_id, AccountType.OTHER)
        )
        for key, txs in sorted(by_key.items())
    ]

    try:
        llm = provider or get_llm_provider(settings)
        for chunk in batched(inputs, BATCH_SIZE, strict=False):
            results = _by_key(llm.classify_merchants(list(chunk)), chunk)
            for item in chunk:
                result = results.get(item.merchant_key)
                if result is None:
                    continue  # model skipped it; stays uncategorized and is retried next sync
                category_id, confidence = pipeline.resolve_category(result)
                db.add(
                    MerchantClassification(
                        merchant_key=item.merchant_key,
                        category_id=category_id,
                        essentiality=result.essentiality,
                        confidence=confidence,
                        source=ClassificationSource.LLM,
                    )
                )
                for tx in by_key[item.merchant_key]:
                    pipeline.assign(
                        tx, category_id, result.essentiality, ClassificationSource.LLM, confidence
                    )
    except Exception:
        log.exception("llm_categorization_failed", pending=len(by_key))


def _by_key(
    results: list[LLMClassification], requested: Sequence[MerchantInput]
) -> dict[str, LLMClassification]:
    wanted = {i.merchant_key for i in requested}
    return {r.merchant_key: r for r in results if r.merchant_key in wanted}


class _Pipeline:
    """Writes categorization rows and counts them."""

    def __init__(self, db: Session, category_ids: dict[str, int]) -> None:
        self.db = db
        self.category_ids = category_ids
        self.count = 0

    def assign(
        self,
        tx: Transaction,
        category_id: int,
        essentiality: Essentiality | None,
        source: ClassificationSource,
        confidence: Confidence,
    ) -> None:
        tx.categorization = Categorization(
            category_id=category_id,
            essentiality=essentiality,
            source=source,
            confidence=confidence,
            updated_at=datetime.now(UTC),
        )
        self.count += 1

    def resolve_category(self, result: LLMClassification) -> tuple[int, Confidence]:
        """Map an LLM answer to a stored category; unknown names fall back to OTHER_OTHER, low."""
        category_id = self.category_ids.get(result.detailed_category)
        if category_id is not None:
            return category_id, result.confidence
        return self.category_ids[FALLBACK_CATEGORY], Confidence.LOW

    def assign_transfer(self, tx: Transaction, account_types: dict[int, AccountType]) -> None:
        inbound = tx.amount > 0
        other = self.db.get(Transaction, tx.transfer_pair_id) if tx.transfer_pair_id else None
        if inbound:
            to_savings = account_types.get(tx.account_id) is AccountType.SAVINGS
            detailed = "TRANSFER_IN_SAVINGS" if to_savings else "TRANSFER_IN_ACCOUNT_TRANSFER"
        else:
            to_savings = (
                other is not None and account_types.get(other.account_id) is AccountType.SAVINGS
            )
            detailed = "TRANSFER_OUT_SAVINGS" if to_savings else "TRANSFER_OUT_ACCOUNT_TRANSFER"
        self.assign(
            tx, self.category_ids[detailed], None, ClassificationSource.RULE, Confidence.HIGH
        )


class _Rules:
    """Exact beats contains beats prefix. Among contains and prefix rules the longest wins."""

    def __init__(self, rules: Sequence[Rule]) -> None:
        self.exact = {r.pattern: r for r in rules if r.match_type is RuleMatchType.EXACT}
        self.contains = self._longest_first(rules, RuleMatchType.CONTAINS)
        self.prefix = self._longest_first(rules, RuleMatchType.PREFIX)

    @staticmethod
    def _longest_first(rules: Sequence[Rule], match_type: RuleMatchType) -> list[Rule]:
        return sorted(
            (r for r in rules if r.match_type is match_type), key=lambda r: (-len(r.pattern), r.id)
        )

    def match(self, key: str, raw_description: str) -> Rule | None:
        if key in self.exact:
            return self.exact[key]
        haystack = raw_description.casefold()
        hit = next((r for r in self.contains if r.pattern.casefold() in haystack), None)
        if hit is not None:
            return hit
        return next((r for r in self.prefix if key.startswith(r.pattern)), None)


def apply_rule(db: Session, rule: Rule) -> int:
    """Re-apply a rule to existing non-transfer transactions whose categorization is not manual.

    Covers transactions that have no categorization yet. Returns how many were changed.
    Does not commit.
    """
    stmt = select(Transaction).where(Transaction.is_transfer.is_(False))
    if rule.match_type is RuleMatchType.EXACT:
        stmt = stmt.where(Transaction.merchant_key == rule.pattern)
    elif rule.match_type is RuleMatchType.CONTAINS:
        stmt = stmt.where(Transaction.raw_description.icontains(rule.pattern, autoescape=True))
    else:
        stmt = stmt.where(Transaction.merchant_key.startswith(rule.pattern, autoescape=True))
    changed = 0
    for tx in db.scalars(stmt):
        current = tx.categorization
        if current is not None and current.source is ClassificationSource.MANUAL:
            continue
        if current is None:
            current = Categorization()
            tx.categorization = current
        current.category_id = rule.category_id
        current.essentiality = rule.essentiality
        current.source = ClassificationSource.RULE
        current.confidence = Confidence.VERY_HIGH
        current.updated_at = datetime.now(UTC)
        changed += 1
    db.flush()
    return changed
