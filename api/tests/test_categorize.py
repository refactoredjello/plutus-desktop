import re
from datetime import UTC, date, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Categorization, Category, MerchantClassification, Rule, Transaction
from app.models.base import (
    AccountType,
    ClassificationSource,
    Confidence,
    Essentiality,
    RuleMatchType,
)
from app.providers.llm.base import MerchantClassification as LLMResult
from app.providers.llm.base import MerchantInput
from app.providers.llm.fake import FakeLLMProvider
from app.providers.llm.prompts import classify_user_message
from app.services.categorize import apply_rule, categorize_pending
from app.services.transfers import match_transfers
from tests.factories import (
    category_id,
    load_simplefin_fixture,
    make_account,
    make_tx,
    settings_with_owner,
)


def _cat(db: Session, tx: Transaction) -> Categorization:
    db.refresh(tx)
    assert tx.categorization is not None
    return tx.categorization


def _detailed(db: Session, c: Categorization) -> str:
    return db.scalars(select(Category.detailed).where(Category.id == c.category_id)).one()


class ExplodingProvider:
    name = "boom"

    def __init__(self) -> None:
        self.calls = 0

    def classify_merchants(self, items: list[MerchantInput]) -> list[LLMResult]:
        self.calls += 1
        raise RuntimeError("provider down")

    def suggest_savings(self, context: object) -> list[object]:
        raise RuntimeError("provider down")


class OddProvider:
    """Answers with a category that does not exist."""

    name = "odd"

    def classify_merchants(self, items: list[MerchantInput]) -> list[LLMResult]:
        return [
            LLMResult(
                i.merchant_key, "NOT_A_CATEGORY", Essentiality.ESSENTIAL, Confidence.VERY_HIGH
            )
            for i in items
        ]


def test_privacy_nothing_sensitive_reaches_the_provider(db: Session) -> None:
    txs = load_simplefin_fixture(db)
    llm = FakeLLMProvider()
    match_transfers(db)
    categorize_pending(db, settings_with_owner(), llm)

    assert llm.classify_calls
    sent = [item for call in llm.classify_calls for item in call]
    payloads = [item.merchant_key for item in sent] + [
        classify_user_message(call) for call in llm.classify_calls
    ]
    for payload in payloads:
        assert not re.search(r"\d{4,}", payload), payload
        upper = payload.upper()
        for forbidden in ("ALEX", "SAMPLE", "JANE", "DOE"):
            assert forbidden not in upper, (forbidden, payload)
    # descriptions that scrub to themselves (e.g. PLANET FITNESS CLUB FEES) are already clean
    raw_descriptions = {t.raw_description for t in txs if t.raw_description != t.merchant_key}
    for payload in payloads:
        assert not any(raw in payload for raw in raw_descriptions)
    for item in sent:
        assert not re.search(r"\d{4,}", item.merchant_key)
    assert len({i.merchant_key for i in sent}) == len(sent)  # deduplicated


def test_fixture_every_transaction_is_categorized(db: Session) -> None:
    txs = load_simplefin_fixture(db)
    match_transfers(db)
    count = categorize_pending(db, settings_with_owner(), FakeLLMProvider())
    assert count == len(txs)
    for t in txs:
        assert _cat(db, t) is not None
        assert t.merchant_key
    assert categorize_pending(db, settings_with_owner(), FakeLLMProvider()) == 0


def test_transfers_get_transfer_categories_without_llm(db: Session) -> None:
    chk = make_account(db, AccountType.CHECKING)
    sav = make_account(db, AccountType.SAVINGS)
    cc = make_account(db, AccountType.CREDIT)
    to_sav = make_tx(db, chk, "-500.00", "ONLINE TRANSFER TO SAV", date(2026, 1, 5))
    from_chk = make_tx(db, sav, "500.00", "ONLINE TRANSFER FROM CHK", date(2026, 1, 5))
    pay = make_tx(db, chk, "-90.00", "PAYMENT TO CARD", date(2026, 1, 6))
    received = make_tx(db, cc, "90.00", "AUTOMATIC PAYMENT", date(2026, 1, 7))
    llm = FakeLLMProvider()
    match_transfers(db)
    categorize_pending(db, settings_with_owner(), llm)

    assert llm.classify_calls == []
    expected = {
        to_sav: "TRANSFER_OUT_SAVINGS",
        from_chk: "TRANSFER_IN_SAVINGS",
        pay: "TRANSFER_OUT_ACCOUNT_TRANSFER",
        received: "TRANSFER_IN_ACCOUNT_TRANSFER",
    }
    for tx, detailed in expected.items():
        c = _cat(db, tx)
        assert _detailed(db, c) == detailed
        assert c.source is ClassificationSource.RULE


def test_rules_beat_cache_beat_llm(db: Session) -> None:
    acct = make_account(db)
    ruled = make_tx(db, acct, "-5.00", "BLUE BOTTLE COFFEE 1234")
    cached = make_tx(db, acct, "-5.00", "NETFLIX.COM")
    fresh = make_tx(db, acct, "-5.00", "SOME RESTAURANT")
    db.add_all(
        [
            Rule(
                match_type=RuleMatchType.EXACT,
                pattern="BLUE BOTTLE COFFEE",
                category_id=category_id(db, "FOOD_AND_DRINK_GROCERIES"),
                essentiality=Essentiality.ESSENTIAL,
            ),
            MerchantClassification(
                merchant_key="BLUE BOTTLE COFFEE",
                category_id=category_id(db, "FOOD_AND_DRINK_COFFEE"),
                essentiality=Essentiality.DISCRETIONARY,
                confidence=Confidence.HIGH,
                source=ClassificationSource.LLM,
            ),
            MerchantClassification(
                merchant_key="NETFLIX.COM",
                category_id=category_id(db, "GENERAL_SERVICES_OTHER_GENERAL_SERVICES"),
                essentiality=Essentiality.FLEXIBLE,
                confidence=Confidence.MEDIUM,
                source=ClassificationSource.LLM,
            ),
        ]
    )
    db.flush()
    llm = FakeLLMProvider()
    categorize_pending(db, settings_with_owner(), llm)

    r, c, f = _cat(db, ruled), _cat(db, cached), _cat(db, fresh)
    assert (_detailed(db, r), r.source, r.confidence) == (
        "FOOD_AND_DRINK_GROCERIES",
        ClassificationSource.RULE,
        Confidence.VERY_HIGH,
    )
    assert r.essentiality is Essentiality.ESSENTIAL
    # the cache entry wins over what the fake LLM would say for NETFLIX
    assert _detailed(db, c) == "GENERAL_SERVICES_OTHER_GENERAL_SERVICES"
    assert (c.source, c.confidence) == (ClassificationSource.CACHE, Confidence.MEDIUM)
    assert (_detailed(db, f), f.source) == ("FOOD_AND_DRINK_RESTAURANT", ClassificationSource.LLM)
    assert [i.merchant_key for call in llm.classify_calls for i in call] == ["SOME RESTAURANT"]


def test_prefix_rule_longest_wins_and_exact_beats_prefix(db: Session) -> None:
    acct = make_account(db)
    a = make_tx(db, acct, "-5.00", "UBER TRIP HELP")
    b = make_tx(db, acct, "-5.00", "UBER EATS")
    c = make_tx(db, acct, "-5.00", "UBER EATS")
    cat = lambda name: category_id(db, name)  # noqa: E731
    db.add_all(
        [
            Rule(
                match_type=RuleMatchType.PREFIX,
                pattern="UBER",
                category_id=cat("TRANSPORTATION_TAXIS_AND_RIDE_SHARES"),
            ),
            Rule(
                match_type=RuleMatchType.PREFIX,
                pattern="UBER EATS",
                category_id=cat("FOOD_AND_DRINK_RESTAURANT"),
            ),
        ]
    )
    db.flush()
    categorize_pending(db, settings_with_owner(), FakeLLMProvider())
    assert _detailed(db, _cat(db, a)) == "TRANSPORTATION_TAXIS_AND_RIDE_SHARES"
    assert _detailed(db, _cat(db, b)) == _detailed(db, _cat(db, c)) == "FOOD_AND_DRINK_RESTAURANT"


def test_cache_prevents_repeat_llm_calls(db: Session) -> None:
    acct = make_account(db)
    first = make_tx(db, acct, "-4.00", "SQ *BLUE BOTTLE COFFEE 1111")
    llm = FakeLLMProvider()
    categorize_pending(db, settings_with_owner(), llm)
    assert len(llm.classify_calls) == 1
    assert _cat(db, first).source is ClassificationSource.LLM
    cached = db.get(MerchantClassification, "BLUE BOTTLE COFFEE")
    assert cached is not None
    assert cached.source is ClassificationSource.LLM

    second = make_tx(db, acct, "-4.50", "SQ *BLUE BOTTLE COFFEE 2222")
    categorize_pending(db, settings_with_owner(), llm)
    assert len(llm.classify_calls) == 1
    assert _cat(db, second).source is ClassificationSource.CACHE


def test_duplicate_keys_in_one_run_are_sent_once(db: Session) -> None:
    acct = make_account(db)
    for n in range(5):
        make_tx(db, acct, "-4.00", f"SQ *BLUE BOTTLE COFFEE {1000 + n}")
    llm = FakeLLMProvider()
    assert categorize_pending(db, settings_with_owner(), llm) == 5
    assert [len(c) for c in llm.classify_calls] == [1]


def test_llm_calls_are_batched_at_fifty(db: Session) -> None:
    acct = make_account(db)
    for n in range(120):
        make_tx(
            db,
            acct,
            "-4.00",
            f"MERCHANT {'ABCDEFGHIJ'[n % 10]}{'KLMNOPQRST'[n // 10 % 10]}{'UVWXYZ'[n // 100]}",
        )
    llm = FakeLLMProvider()
    categorize_pending(db, settings_with_owner(), llm)
    assert [len(c) for c in llm.classify_calls] == [50, 50, 20]


def test_llm_failure_leaves_transactions_uncategorized_and_does_not_raise(db: Session) -> None:
    acct = make_account(db)
    tx = make_tx(db, acct, "-4.00", "MYSTERY SHOP")
    provider = ExplodingProvider()
    assert categorize_pending(db, settings_with_owner(), provider) == 0  # type: ignore[arg-type]
    assert provider.calls == 1
    db.refresh(tx)
    assert tx.categorization is None
    assert tx.merchant_key == "MYSTERY SHOP"
    assert db.scalar(select(func.count()).select_from(MerchantClassification)) == 0
    # Next sync retries and succeeds.
    assert categorize_pending(db, settings_with_owner(), FakeLLMProvider()) == 1


def test_missing_provider_config_does_not_raise(db: Session) -> None:
    from app.config import Settings

    acct = make_account(db)
    make_tx(db, acct, "-4.00", "MYSTERY SHOP")
    settings = Settings(llm_provider="claude", anthropic_api_key=None)  # type: ignore[arg-type]
    assert categorize_pending(db, settings) == 0


def test_unknown_llm_category_falls_back_to_other_with_low_confidence(db: Session) -> None:
    acct = make_account(db)
    tx = make_tx(db, acct, "-4.00", "MYSTERY SHOP")
    categorize_pending(db, settings_with_owner(), OddProvider())  # type: ignore[arg-type]
    c = _cat(db, tx)
    assert _detailed(db, c) == "OTHER_OTHER"
    assert c.confidence is Confidence.LOW
    entry = db.get(MerchantClassification, "MYSTERY SHOP")
    assert entry is not None
    assert entry.confidence is Confidence.LOW


def test_already_categorized_transactions_are_left_alone(db: Session) -> None:
    acct = make_account(db)
    tx = make_tx(db, acct, "-4.00", "NETFLIX.COM")
    tx.categorization = Categorization(
        category_id=category_id(db, "OTHER_OTHER"),
        source=ClassificationSource.MANUAL,
        confidence=Confidence.VERY_HIGH,
        updated_at=datetime.now(UTC),
    )
    db.flush()
    llm = FakeLLMProvider()
    assert categorize_pending(db, settings_with_owner(), llm) == 0
    assert llm.classify_calls == []


def _rule(db: Session, match_type: RuleMatchType, pattern: str, detailed: str) -> Rule:
    rule = Rule(
        match_type=match_type,
        pattern=pattern,
        category_id=category_id(db, detailed),
        essentiality=Essentiality.FLEXIBLE,
    )
    db.add(rule)
    db.flush()
    return rule


def test_rule_precedence_exact_then_contains_then_prefix(db: Session) -> None:
    acct = make_account(db)
    tx = make_tx(db, acct, "-5.00", "ACME COFFEE SHOP 123")
    _rule(db, RuleMatchType.PREFIX, "ACME", "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE")
    _rule(db, RuleMatchType.CONTAINS, "coffee", "FOOD_AND_DRINK_COFFEE")
    llm = FakeLLMProvider()
    categorize_pending(db, settings_with_owner(), llm)
    c = _cat(db, tx)
    assert _detailed(db, c) == "FOOD_AND_DRINK_COFFEE"
    assert (c.source, c.confidence) == (ClassificationSource.RULE, Confidence.VERY_HIGH)
    assert llm.classify_calls == []

    tx2 = make_tx(db, acct, "-5.00", "ACME COFFEE SHOP 123")
    assert tx2.merchant_key is None
    _rule(db, RuleMatchType.EXACT, "ACME COFFEE SHOP 123", "FOOD_AND_DRINK_RESTAURANT")
    categorize_pending(db, settings_with_owner(), llm)
    assert _detailed(db, _cat(db, tx2)) == "FOOD_AND_DRINK_RESTAURANT"


def test_contains_longest_pattern_wins_and_is_case_insensitive(db: Session) -> None:
    tx = make_tx(db, make_account(db), "-5.00", "Whole Foods Market Cafe")
    _rule(db, RuleMatchType.CONTAINS, "FOODS", "FOOD_AND_DRINK_GROCERIES")
    _rule(db, RuleMatchType.CONTAINS, "whole foods market", "FOOD_AND_DRINK_RESTAURANT")
    llm = FakeLLMProvider()
    categorize_pending(db, settings_with_owner(), llm)
    assert _detailed(db, _cat(db, tx)) == "FOOD_AND_DRINK_RESTAURANT"
    assert llm.classify_calls == []


def test_contains_matches_raw_description_not_scrubbed_key(db: Session) -> None:
    tx = make_tx(db, make_account(db), "-5.00", "SQ *BLUE BOTTLE 4821 OAKLAND")
    _rule(db, RuleMatchType.CONTAINS, "4821", "FOOD_AND_DRINK_COFFEE")
    categorize_pending(db, settings_with_owner(), FakeLLMProvider())
    assert _detailed(db, _cat(db, tx)) == "FOOD_AND_DRINK_COFFEE"


def test_apply_rule_respects_manual_and_transfers(db: Session) -> None:
    acct = make_account(db)
    plain = make_tx(db, acct, "-5.00", "Corner Coffee")
    fresh = make_tx(db, acct, "-6.00", "COFFEE BAR")
    manual = make_tx(db, acct, "-7.00", "My coffee")
    transfer = make_tx(db, acct, "-8.00", "coffee transfer", is_transfer=True)
    other = make_tx(db, acct, "-9.00", "Gas station")
    for tx in (plain, manual):
        tx.categorization = Categorization(
            category_id=category_id(db, "OTHER_OTHER"),
            source=(ClassificationSource.MANUAL if tx is manual else ClassificationSource.LLM),
            confidence=Confidence.LOW,
            updated_at=datetime.now(UTC),
        )
    db.flush()
    rule = _rule(db, RuleMatchType.CONTAINS, "coffee", "FOOD_AND_DRINK_COFFEE")

    assert apply_rule(db, rule) == 2
    for tx in (plain, fresh):
        c = _cat(db, tx)
        assert _detailed(db, c) == "FOOD_AND_DRINK_COFFEE"
        assert (c.source, c.confidence) == (ClassificationSource.RULE, Confidence.VERY_HIGH)
        assert c.essentiality is Essentiality.FLEXIBLE
    assert _cat(db, manual).source is ClassificationSource.MANUAL
    db.refresh(transfer)
    db.refresh(other)
    assert transfer.categorization is None
    assert other.categorization is None


def test_notes_never_reach_the_llm(db: Session) -> None:
    acct = make_account(db)
    secret = "zxqnote therapy sessions"
    make_tx(db, acct, "-120.00", "SOME CLINIC 1234", note=secret)
    make_tx(db, acct, "-12.00", "NETFLIX.COM CA", note=secret)
    llm = FakeLLMProvider()
    categorize_pending(db, settings_with_owner(), llm)
    assert llm.classify_calls
    for call in llm.classify_calls:
        blob = repr(call) + classify_user_message(call)
        assert "zxqnote" not in blob
        assert "therapy" not in blob.lower()
