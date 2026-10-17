import dataclasses
import re
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import ProviderError
from app.main import app
from app.models import (
    BalanceSnapshot,
    Categorization,
    Category,
    RecurringCharge,
    Suggestion,
)
from app.models.base import (
    Cadence,
    ClassificationSource,
    Essentiality,
    RecurrenceStatus,
)
from app.providers.llm.base import SavingsContext, SavingsSuggestion
from app.providers.llm.fake import FakeLLMProvider
from app.routers.goals import get_llm
from app.services import schedule
from tests.factories import make_account, make_tx

TODAY = date(2026, 10, 15)
NETFLIX_KEY = "NETFLIX.COM CA"


@pytest.fixture(autouse=True)
def frozen_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(schedule, "today", lambda: TODAY)


@pytest.fixture
def llm(client: TestClient, fake_llm: FakeLLMProvider) -> FakeLLMProvider:
    app.dependency_overrides[get_llm] = lambda: fake_llm
    return fake_llm


def categorize(db: Session, tx_id: int, detailed: str, ess: Essentiality | None = None) -> None:
    cat = db.scalars(select(Category).where(Category.detailed == detailed)).one()
    db.add(
        Categorization(
            transaction_id=tx_id,
            category_id=cat.id,
            essentiality=ess,
            source=ClassificationSource.MANUAL,
            updated_at=datetime.now(UTC),
        )
    )
    db.flush()


def make_goal(client: TestClient) -> int:
    body = {"name": "Emergency fund", "target_amount": "5000", "target_date": "2027-04-15"}
    return int(client.post("/api/goals", json=body).json()["id"])


def test_generate_stores_and_lists_newest_first(client: TestClient, llm: FakeLLMProvider) -> None:
    gid = make_goal(client)
    r = client.post(f"/api/goals/{gid}/suggestions")
    assert r.status_code == 201
    created = r.json()
    assert [s["text"] for s in created] == ["Set a weekly cap on dining out."]
    assert created[0]["status"] == "open"
    assert created[0]["estimated_monthly_saving"] == "50.00"
    assert len(llm.suggest_calls) == 1

    class Second:
        name = "second"

        def classify_merchants(self, items: Any) -> Any:
            raise AssertionError

        def suggest_savings(self, context: SavingsContext) -> list[SavingsSuggestion]:
            return [SavingsSuggestion("Cancel gym", None, None)]

    app.dependency_overrides[get_llm] = lambda: Second()
    client.post(f"/api/goals/{gid}/suggestions")
    texts = [s["text"] for s in client.get(f"/api/goals/{gid}/suggestions").json()]
    assert texts == ["Cancel gym", "Set a weekly cap on dining out."]


def test_category_resolved_by_exact_label(
    client: TestClient, db: Session, llm: FakeLLMProvider
) -> None:
    label = db.scalars(
        select(Category.label).where(Category.detailed == "FOOD_AND_DRINK_COFFEE")
    ).one()

    class Provider:
        name = "p"

        def classify_merchants(self, items: Any) -> Any:
            raise AssertionError

        def suggest_savings(self, context: SavingsContext) -> list[SavingsSuggestion]:
            return [
                SavingsSuggestion("Fewer lattes", label, Decimal("20")),
                SavingsSuggestion("Mystery", "No Such Label", None),
            ]

    app.dependency_overrides[get_llm] = lambda: Provider()
    gid = make_goal(client)
    out = client.post(f"/api/goals/{gid}/suggestions").json()
    assert out[0]["category_id"] is not None
    assert out[1]["category_id"] is None


def test_dismissed_passed_as_exclusions(
    client: TestClient, db: Session, llm: FakeLLMProvider
) -> None:
    gid = make_goal(client)
    first = client.post(f"/api/goals/{gid}/suggestions").json()[0]
    assert llm.suggest_calls[0].excluded_suggestions == []
    client.patch(f"/api/suggestions/{first['id']}", json={"status": "kept"})
    client.post(f"/api/goals/{gid}/suggestions")
    assert llm.suggest_calls[1].excluded_suggestions == []
    r = client.patch(f"/api/suggestions/{first['id']}", json={"status": "dismissed"})
    assert r.json()["status"] == "dismissed"
    client.post(f"/api/goals/{gid}/suggestions")
    assert llm.suggest_calls[2].excluded_suggestions == [first["text"]]
    other = make_goal(client)
    client.post(f"/api/goals/{other}/suggestions")
    assert llm.suggest_calls[3].excluded_suggestions == []
    assert db.get(Suggestion, first["id"]) is not None


def test_provider_failure_surfaces_502(client: TestClient, db: Session) -> None:
    class Broken:
        name = "broken"

        def classify_merchants(self, items: Any) -> Any:
            raise AssertionError

        def suggest_savings(self, context: SavingsContext) -> list[SavingsSuggestion]:
            raise ProviderError("down")

    app.dependency_overrides[get_llm] = lambda: Broken()
    gid = make_goal(client)
    r = client.post(f"/api/goals/{gid}/suggestions")
    assert r.status_code == 502
    assert db.scalars(select(Suggestion)).all() == []


def test_404s(client: TestClient, llm: FakeLLMProvider) -> None:
    assert client.post("/api/goals/999999/suggestions").status_code == 404
    assert client.get("/api/goals/999999/suggestions").status_code == 404
    r = client.patch("/api/suggestions/999999", json={"status": "kept"})
    assert r.status_code == 404


def _walk(value: object) -> str:
    """Flatten a context to text; Decimal amounts are replaced so digit runs can be checked."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return " ".join(_walk(getattr(value, f.name)) for f in dataclasses.fields(value))
    if isinstance(value, list):
        return " ".join(_walk(v) for v in value)
    if isinstance(value, Decimal):
        return "AMOUNT"
    return str(value)


def test_context_is_aggregates_only(client: TestClient, db: Session, llm: FakeLLMProvider) -> None:
    acct = make_account(db, name="Jane Q Public Checking 12345678")
    set_balance = BalanceSnapshot(
        account_id=acct.id, balance=Decimal("98765.43"), as_of=datetime.now(UTC)
    )
    db.add(set_balance)
    desc_netflix = "NETFLIX.COM CA 408-540-3700 REF 998877665544"
    desc_coffee = "SQ *BLUE BOTTLE COFFEE #4412 SAN FRANCISCO"
    desc_rent = "ZELLE TO LANDLORD JOHN SMITH 20260905"
    for month in (5, 6, 7, 8, 9):
        nf = make_tx(
            db, acct, "-15.49", desc_netflix, date(2026, month, 3), merchant_key=NETFLIX_KEY
        )
        categorize(db, nf.id, "ENTERTAINMENT_TV_AND_MOVIES", Essentiality.DISCRETIONARY)
        cf = make_tx(
            db, acct, "-6.25", desc_coffee, date(2026, month, 9), merchant_key="BLUE BOTTLE COFFEE"
        )
        categorize(db, cf.id, "FOOD_AND_DRINK_COFFEE", Essentiality.DISCRETIONARY)
        rt = make_tx(db, acct, "-1800", desc_rent, date(2026, month, 1), merchant_key="ZELLE TO")
        categorize(db, rt.id, "RENT_AND_UTILITIES_RENT", Essentiality.ESSENTIAL)
    # Current (incomplete) month must not appear in the history.
    make_tx(db, acct, "-999", "CURRENT MONTH SPEND", date(2026, 10, 2))
    db.add(
        RecurringCharge(
            merchant_key=NETFLIX_KEY,
            account_id=acct.id,
            amount=Decimal("-15.49"),
            cadence=Cadence.MONTHLY,
            next_expected_date=date(2026, 11, 3),
            status=RecurrenceStatus.CONFIRMED,
            essentiality=Essentiality.DISCRETIONARY,
        )
    )
    # Proposed and essential charges are excluded.
    db.add(
        RecurringCharge(
            merchant_key="SECRET PROPOSED",
            account_id=acct.id,
            amount=Decimal("-9.99"),
            cadence=Cadence.MONTHLY,
            next_expected_date=date(2026, 11, 3),
            status=RecurrenceStatus.PROPOSED,
            essentiality=Essentiality.DISCRETIONARY,
        )
    )
    db.add(
        RecurringCharge(
            merchant_key="LANDLORD ESSENTIAL",
            account_id=acct.id,
            amount=Decimal("-1800"),
            cadence=Cadence.MONTHLY,
            next_expected_date=date(2026, 11, 1),
            status=RecurrenceStatus.CONFIRMED,
            essentiality=Essentiality.ESSENTIAL,
        )
    )
    db.flush()

    gid = make_goal(client)
    assert client.post(f"/api/goals/{gid}/suggestions").status_code == 201
    ctx = llm.suggest_calls[-1]

    assert len(ctx.recurring) == 1
    rec = ctx.recurring[0]
    expected = db.scalars(
        select(Category.label).where(Category.detailed == "ENTERTAINMENT_TV_AND_MOVIES")
    ).one()
    assert rec.category_label == expected
    assert rec.amount == Decimal("15.49")
    assert rec.cadence == "monthly"
    labels = {c.label: c for c in ctx.categories}
    assert all(len(c.monthly_totals) == 6 for c in ctx.categories)
    rent = next(c for c in ctx.categories if c.monthly_totals[-1] == Decimal("1800.00"))
    assert rent.monthly_totals == [Decimal("0.00"), *[Decimal("1800.00")] * 5]
    assert all(Decimal("999") not in c.monthly_totals for c in labels.values())

    text = _walk(ctx)
    for forbidden in (
        NETFLIX_KEY,
        "NETFLIX",
        "SECRET PROPOSED",
        "LANDLORD",
        "BLUE BOTTLE",
        "ZELLE",
        "SMITH",
        "Jane",
        "Public",
        "Checking",
        "408-540-3700",
        "CURRENT MONTH",
    ):
        assert forbidden.lower() not in text.lower()
    assert not re.search(r"\d{4,}", text)
    assert "98765" not in repr(ctx)


def test_notes_never_reach_the_suggestion_context(
    client: TestClient, db: Session, llm: FakeLLMProvider
) -> None:
    acct = make_account(db)
    for month in (5, 6, 7, 8, 9):
        tx = make_tx(
            db,
            acct,
            "-15.49",
            "NETFLIX.COM CA",
            date(2026, month, 3),
            merchant_key=NETFLIX_KEY,
            note="zxqnote shared with my sister",
        )
        categorize(db, tx.id, "ENTERTAINMENT_TV_AND_MOVIES", Essentiality.DISCRETIONARY)
    gid = make_goal(client)
    assert client.post(f"/api/goals/{gid}/suggestions").status_code == 201
    assert llm.suggest_calls
    blob = repr(llm.suggest_calls)
    assert "zxqnote" not in blob
    assert "sister" not in blob
