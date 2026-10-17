from datetime import date

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Categorization, MerchantClassification, Rule, Transaction
from app.models.base import ClassificationSource, Confidence, Essentiality
from tests.factories import category_id, make_account, make_tx


def _categorize(
    db: Session,
    tx: Transaction,
    detailed: str = "FOOD_AND_DRINK_COFFEE",
    confidence: Confidence = Confidence.HIGH,
    source: ClassificationSource = ClassificationSource.LLM,
    essentiality: Essentiality | None = Essentiality.DISCRETIONARY,
) -> None:
    from datetime import UTC, datetime

    tx.categorization = Categorization(
        category_id=category_id(db, detailed),
        essentiality=essentiality,
        source=source,
        confidence=confidence,
        updated_at=datetime.now(UTC),
    )
    db.flush()


def _ids(body: dict[str, object]) -> list[int]:
    return [item["id"] for item in body["items"]]  # type: ignore[index, union-attr]


def test_list_newest_first_with_pagination(client: TestClient, db: Session) -> None:
    acct = make_account(db)
    txs = [make_tx(db, acct, "-1.00", f"M {n}", date(2026, 3, n + 1)) for n in range(5)]
    same_day_a = make_tx(db, acct, "-2.00", "SAME DAY A", date(2026, 3, 5))
    page1 = client.get("/api/transactions", params={"limit": 2}).json()
    assert page1["total"] == 6
    assert (page1["limit"], page1["offset"]) == (2, 0)
    assert _ids(page1) == [same_day_a.id, txs[4].id]
    page2 = client.get("/api/transactions", params={"limit": 2, "offset": 2}).json()
    assert _ids(page2) == [txs[3].id, txs[2].id]
    assert page2["total"] == 6
    assert client.get("/api/transactions", params={"limit": 0}).status_code == 422


def test_read_shape_includes_categorization(client: TestClient, db: Session) -> None:
    tx = make_tx(db, make_account(db), "-4.25", "SQ *BLUE BOTTLE 1234")
    _categorize(db, tx)
    item = client.get("/api/transactions").json()["items"][0]
    assert item["amount"] == "-4.25"
    assert item["categorization"]["source"] == "llm"
    assert item["categorization"]["essentiality"] == "discretionary"
    assert item["categorization"]["confidence"] == "high"


def test_filters(client: TestClient, db: Session) -> None:
    a, b = make_account(db), make_account(db)
    coffee = make_tx(db, a, "-4.00", "BLUE BOTTLE COFFEE", date(2026, 1, 5), payee="Blue Bottle")
    grocery = make_tx(db, b, "-40.00", "TRADER JOE S", date(2026, 2, 5), payee="Trader Joe's")
    rent = make_tx(db, b, "-2000.00", "ZELLE TO", date(2026, 3, 5))
    _categorize(db, coffee)
    _categorize(db, grocery, "FOOD_AND_DRINK_GROCERIES", essentiality=Essentiality.ESSENTIAL)
    _categorize(
        db, rent, "RENT_AND_UTILITIES_RENT", Confidence.LOW, essentiality=Essentiality.ESSENTIAL
    )

    def ids(**params: object) -> set[int]:
        r = client.get("/api/transactions", params=params)  # type: ignore[arg-type]
        assert r.status_code == 200
        return set(_ids(r.json()))

    assert ids(q="bottle") == {coffee.id}  # case-insensitive, raw description
    assert ids(q="TRADER JOE'S") == {grocery.id}  # payee
    assert ids(q="100%") == set()  # wildcard characters are literal
    assert ids(start="2026-02-01", end="2026-02-28") == {grocery.id}
    assert ids(account_id=a.id) == {coffee.id}
    assert ids(account_id=[a.id, b.id]) == {coffee.id, grocery.id, rent.id}
    assert ids(category_id=category_id(db, "FOOD_AND_DRINK_GROCERIES")) == {grocery.id}
    assert ids(essentiality="essential") == {grocery.id, rent.id}
    assert ids(needs_review="true") == {rent.id}


def test_needs_review_includes_uncategorized_and_unknown(client: TestClient, db: Session) -> None:
    acct = make_account(db)
    none = make_tx(db, acct, "-1.00")
    unknown = make_tx(db, acct, "-2.00")
    ok = make_tx(db, acct, "-3.00")
    _categorize(db, unknown, confidence=Confidence.UNKNOWN)
    _categorize(db, ok, confidence=Confidence.MEDIUM)
    body = client.get("/api/transactions", params={"needs_review": "true"}).json()
    assert set(_ids(body)) == {none.id, unknown.id}
    assert body["total"] == 2


def test_transfers_excluded_unless_requested(client: TestClient, db: Session) -> None:
    acct = make_account(db)
    normal = make_tx(db, acct, "-1.00")
    transfer = make_tx(db, acct, "-500.00", is_transfer=True)
    assert _ids(client.get("/api/transactions").json()) == [normal.id]
    both = client.get("/api/transactions", params={"include_transfers": "true"}).json()
    assert set(_ids(both)) == {normal.id, transfer.id}
    assert both["total"] == 2


# --- PATCH ------------------------------------------------------------------------------------


def test_patch_manual_override(client: TestClient, db: Session) -> None:
    tx = make_tx(db, make_account(db), "-4.00", "MYSTERY SHOP")
    _categorize(db, tx, "OTHER_OTHER", Confidence.LOW)
    cat = category_id(db, "FOOD_AND_DRINK_RESTAURANT")
    r = client.patch(
        f"/api/transactions/{tx.id}", json={"category_id": cat, "essentiality": "flexible"}
    )
    assert r.status_code == 200
    assert r.json()["categorization"] == {
        "category_id": cat,
        "essentiality": "flexible",
        "source": "manual",
        "confidence": "very_high",
    }
    assert db.scalars(select(Rule)).all() == []


def test_patch_essentiality_only_and_clearing(client: TestClient, db: Session) -> None:
    tx = make_tx(db, make_account(db), "-4.00")
    _categorize(db, tx)
    cat = category_id(db, "FOOD_AND_DRINK_COFFEE")
    r = client.patch(f"/api/transactions/{tx.id}", json={"essentiality": "essential"})
    assert r.json()["categorization"]["category_id"] == cat
    assert r.json()["categorization"]["essentiality"] == "essential"
    assert r.json()["categorization"]["source"] == "manual"
    r = client.patch(f"/api/transactions/{tx.id}", json={"essentiality": None})
    assert r.json()["categorization"]["essentiality"] is None


def test_patch_uncategorized_requires_category(client: TestClient, db: Session) -> None:
    tx = make_tx(db, make_account(db), "-4.00")
    r = client.patch(f"/api/transactions/{tx.id}", json={"essentiality": "essential"})
    assert r.status_code == 400
    r = client.patch(
        f"/api/transactions/{tx.id}", json={"category_id": category_id(db, "OTHER_OTHER")}
    )
    assert r.status_code == 200
    assert r.json()["categorization"]["source"] == "manual"


def test_patch_errors(client: TestClient, db: Session) -> None:
    tx = make_tx(db, make_account(db), "-4.00")
    missing = client.patch("/api/transactions/999999", json={"category_id": 1})
    assert missing.status_code == 404
    assert missing.headers["content-type"].startswith("application/problem+json")
    unknown = client.patch(f"/api/transactions/{tx.id}", json={"category_id": 999999})
    assert unknown.status_code == 400


def test_save_as_rule_creates_rule_cache_and_propagates(client: TestClient, db: Session) -> None:
    acct = make_account(db)
    target = make_tx(
        db, acct, "-4.00", "SQ *BLUE BOTTLE COFFEE 1234", merchant_key="BLUE BOTTLE COFFEE"
    )
    llm_peer = make_tx(
        db, acct, "-5.00", "SQ *BLUE BOTTLE COFFEE 5678", merchant_key="BLUE BOTTLE COFFEE"
    )
    manual_peer = make_tx(
        db, acct, "-6.00", "SQ *BLUE BOTTLE COFFEE 9012", merchant_key="BLUE BOTTLE COFFEE"
    )
    fresh_peer = make_tx(
        db, acct, "-7.00", "SQ *BLUE BOTTLE COFFEE 3456", merchant_key="BLUE BOTTLE COFFEE"
    )
    other = make_tx(db, acct, "-8.00", "NETFLIX", merchant_key="NETFLIX")
    for tx in (target, llm_peer, other):
        _categorize(db, tx, "OTHER_OTHER", Confidence.LOW)
    _categorize(db, manual_peer, "OTHER_OTHER", Confidence.VERY_HIGH, ClassificationSource.MANUAL)

    cat = category_id(db, "FOOD_AND_DRINK_COFFEE")
    r = client.patch(
        f"/api/transactions/{target.id}",
        json={"category_id": cat, "essentiality": "discretionary", "save_as_rule": True},
    )
    assert r.status_code == 200

    rule = db.scalars(select(Rule)).one()
    assert (rule.match_type.value, rule.pattern, rule.category_id) == (
        "exact",
        "BLUE BOTTLE COFFEE",
        cat,
    )
    assert rule.essentiality is Essentiality.DISCRETIONARY
    cached = db.get(MerchantClassification, "BLUE BOTTLE COFFEE")
    assert cached is not None
    assert (cached.source, cached.category_id) == (ClassificationSource.MANUAL, cat)

    for tx in (target, llm_peer, fresh_peer, manual_peer, other):
        db.refresh(tx)
    assert target.categorization.source is ClassificationSource.MANUAL  # type: ignore[union-attr]
    for tx in (llm_peer, fresh_peer):
        c = tx.categorization
        assert c is not None
        assert (c.category_id, c.source, c.confidence) == (
            cat,
            ClassificationSource.RULE,
            Confidence.VERY_HIGH,
        )
    assert manual_peer.categorization.category_id == category_id(db, "OTHER_OTHER")  # type: ignore[union-attr]
    assert other.categorization.category_id == category_id(db, "OTHER_OTHER")  # type: ignore[union-attr]


def test_save_as_rule_updates_existing_rule_and_supports_prefix(
    client: TestClient, db: Session
) -> None:
    acct = make_account(db)
    tx = make_tx(db, acct, "-4.00", "UBER TRIP", merchant_key="UBER TRIP")
    peer = make_tx(db, acct, "-4.00", "UBER EATS", merchant_key="UBER EATS")
    _categorize(db, tx, "OTHER_OTHER", Confidence.LOW)
    _categorize(db, peer, "OTHER_OTHER", Confidence.LOW)

    def save(match_type: str, detailed: str) -> None:
        r = client.patch(
            f"/api/transactions/{tx.id}",
            json={
                "category_id": category_id(db, detailed),
                "save_as_rule": True,
                "rule_match_type": match_type,
            },
        )
        assert r.status_code == 200

    save("exact", "TRANSPORTATION_TAXIS_AND_RIDE_SHARES")
    save("exact", "TRANSPORTATION_PUBLIC_TRANSIT")
    rules = db.scalars(select(Rule)).all()
    assert len(rules) == 1
    assert rules[0].category_id == category_id(db, "TRANSPORTATION_PUBLIC_TRANSIT")

    # "UBER" prefix would match both; here the prefix pattern is the full key "UBER TRIP".
    save("prefix", "TRANSPORTATION_TAXIS_AND_RIDE_SHARES")
    assert len(db.scalars(select(Rule)).all()) == 2
    db.refresh(peer)
    assert peer.categorization.category_id == category_id(db, "OTHER_OTHER")  # type: ignore[union-attr]


def test_save_as_rule_computes_missing_merchant_key(client: TestClient, db: Session) -> None:
    tx = make_tx(db, make_account(db), "-4.00", "SQ *BLUE BOTTLE COFFEE 1234")
    r = client.patch(
        f"/api/transactions/{tx.id}",
        json={"category_id": category_id(db, "FOOD_AND_DRINK_COFFEE"), "save_as_rule": True},
    )
    assert r.status_code == 200
    assert r.json()["merchant_key"] == "BLUE BOTTLE COFFEE"
    assert db.scalars(select(Rule)).one().pattern == "BLUE BOTTLE COFFEE"


def test_filter_uncategorized_and_unset_essentiality(client: TestClient, db: Session) -> None:
    from datetime import UTC, datetime

    from app.models import Categorization, Category
    from app.models.base import ClassificationSource
    from tests.factories import make_account, make_tx

    chk = make_account(db)
    bare = make_tx(db, chk, "-9.00", "MYSTERY")
    no_ess = make_tx(db, chk, "-40.00", "GIFT")
    cat = db.scalars(select(Category).where(Category.detailed == "FOOD_AND_DRINK_COFFEE")).one()
    db.add(
        Categorization(
            transaction_id=no_ess.id,
            category_id=cat.id,
            essentiality=None,
            source=ClassificationSource.MANUAL,
            updated_at=datetime.now(UTC),
        )
    )
    db.flush()

    def ids(params: dict[str, object]) -> set[int]:
        items = client.get("/api/transactions", params=params).json()["items"]
        return {t["id"] for t in items}

    assert ids({"uncategorized": True}) == {bare.id}
    assert ids({"essentiality": "unset"}) == {bare.id, no_ess.id}


def test_note_set_strip_and_clear(client: TestClient, db: Session) -> None:
    tx = make_tx(db, make_account(db), "-4.00", "CLINIC")
    _categorize(db, tx, "OTHER_OTHER", Confidence.LOW)
    r = client.patch(f"/api/transactions/{tx.id}", json={"note": "  Therapy, September  "})
    assert r.status_code == 200
    assert r.json()["note"] == "Therapy, September"
    # A note-only change leaves categorization source and confidence alone.
    assert r.json()["categorization"]["source"] == "llm"
    assert r.json()["categorization"]["confidence"] == "low"
    assert client.patch(f"/api/transactions/{tx.id}", json={"note": "   "}).json()["note"] is None
    client.patch(f"/api/transactions/{tx.id}", json={"note": "again"})
    assert client.patch(f"/api/transactions/{tx.id}", json={"note": None}).json()["note"] is None
    client.patch(f"/api/transactions/{tx.id}", json={"note": "keep"})
    r = client.patch(
        f"/api/transactions/{tx.id}", json={"category_id": category_id(db, "OTHER_OTHER")}
    )
    assert r.json()["note"] == "keep"  # note absent from the request is untouched


def test_note_only_patch_on_uncategorized_transaction(client: TestClient, db: Session) -> None:
    tx = make_tx(db, make_account(db), "-4.00", "MYSTERY")
    r = client.patch(f"/api/transactions/{tx.id}", json={"note": "cash for Sam"})
    assert r.status_code == 200
    assert r.json()["note"] == "cash for Sam"
    assert r.json()["categorization"] is None
    # Changing the category still requires one.
    assert (
        client.patch(f"/api/transactions/{tx.id}", json={"essentiality": "flexible"}).status_code
        == 400
    )


def test_q_matches_note_case_insensitively(client: TestClient, db: Session) -> None:
    acct = make_account(db)
    with_note = make_tx(db, acct, "-4.00", "AAA", note="Birthday Gift")
    make_tx(db, acct, "-5.00", "BBB")
    body = client.get("/api/transactions", params={"q": "birthday"}).json()
    assert _ids(body) == [with_note.id]


def test_one_time_toggle_leaves_categorization_alone(client: TestClient, db: Session) -> None:
    tx = make_tx(db, make_account(db), "-900.00", "PARKING FINE")
    _categorize(db, tx, "OTHER_OTHER", Confidence.LOW)
    r = client.patch(f"/api/transactions/{tx.id}", json={"one_time": True})
    assert r.status_code == 200
    assert r.json()["one_time"] is True
    assert r.json()["categorization"]["source"] == "llm"
    off = client.patch(f"/api/transactions/{tx.id}", json={"one_time": False})
    assert off.json()["one_time"] is False
    # Absent from a category edit, the flag is untouched.
    client.patch(f"/api/transactions/{tx.id}", json={"one_time": True})
    r = client.patch(
        f"/api/transactions/{tx.id}", json={"category_id": category_id(db, "OTHER_OTHER")}
    )
    assert r.json()["one_time"] is True
