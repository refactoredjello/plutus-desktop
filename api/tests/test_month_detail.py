from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.models import Categorization
from app.models.base import AccountType, Confidence, Essentiality
from app.services import schedule
from tests.factories import make_account, make_tx
from tests.test_aggregates import categorize


@pytest.fixture(autouse=True)
def fixed_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(schedule, "today", lambda: date(2026, 10, 4))


def seed(db: Session) -> None:
    chk = make_account(db, AccountType.CHECKING)
    # June is empty: averages must skip it rather than dilute.
    for month, pay, rent, coffee in [
        (5, "3000.00", "-1000.00", "-50.00"),
        (7, "3000.00", "-1000.00", "-80.00"),
        (8, "3600.00", "-1000.00", "-110.00"),
    ]:
        p = make_tx(db, chk, pay, "PAY", date(2026, month, 1))
        categorize(db, p.id, "INCOME_SALARY")
        r = make_tx(db, chk, rent, "RENT", date(2026, month, 2))
        categorize(db, r.id, "RENT_AND_UTILITIES_RENT", Essentiality.ESSENTIAL)
        c = make_tx(db, chk, coffee, "COFFEE", date(2026, month, 3))
        categorize(db, c.id, "FOOD_AND_DRINK_COFFEE", Essentiality.DISCRETIONARY)
    # September: the month under test.
    p = make_tx(db, chk, "3000.00", "PAY", date(2026, 9, 1))
    categorize(db, p.id, "INCOME_SALARY")
    r = make_tx(db, chk, "-1000.00", "RENT", date(2026, 9, 2))
    categorize(db, r.id, "RENT_AND_UTILITIES_RENT", Essentiality.ESSENTIAL)
    for day, amount in [(5, "-40.00"), (6, "-60.00")]:
        c = make_tx(db, chk, amount, "COFFEE", date(2026, 9, day))
        categorize(db, c.id, "FOOD_AND_DRINK_COFFEE", Essentiality.DISCRETIONARY)
    # Categorized rows are confident; only the uncategorized one below needs review.
    db.execute(update(Categorization).values(confidence=Confidence.VERY_HIGH))
    make_tx(db, chk, "-25.00", "MYSTERY", date(2026, 9, 9))
    make_tx(db, chk, "-500.00", "TO SAVINGS", date(2026, 9, 10), is_transfer=True)
    db.flush()


def test_month_detail_totals_averages_and_breakdown(client: TestClient, db: Session) -> None:
    seed(db)
    d = client.get("/api/reports/month/2026-09").json()
    assert d["is_complete"] is True
    assert (d["days_elapsed"], d["days_in_month"]) == (30, 30)
    assert d["average_months"] == 3  # May, July, August; empty June skipped
    assert d["income"] == "3000.00"
    assert d["income_average"] == "3200.00"
    assert d["expenses"] == "1125.00"
    assert d["expenses_average"] == "1080.00"  # (1050 + 1080 + 1110) / 3
    assert d["net"] == "1875.00"
    assert d["savings_rate"] == 0.625
    shares = {e["essentiality"]: (e["total"], e["share"]) for e in d["essentiality"]}
    assert shares["essential"] == ("1000.00", 0.8889)
    assert shares["discretionary"] == ("100.00", 0.0889)
    assert shares["unset"] == ("25.00", 0.0222)
    cats = {c["label"]: c for c in d["categories"]}
    assert [c["label"] for c in d["categories"]] == ["Rent", "Coffee", "Uncategorized"]
    assert cats["Coffee"]["total"] == "100.00"
    assert cats["Coffee"]["count"] == 2
    assert cats["Coffee"]["average"] == "80.00"
    assert cats["Uncategorized"]["average"] == "0.00"
    assert [t["amount"] for t in d["largest"]] == ["-1000.00", "-60.00", "-40.00", "-25.00"]
    assert d["transaction_count"] == 5  # transfer excluded
    assert d["review_count"] == 1


def test_current_month_is_in_progress(client: TestClient, db: Session) -> None:
    seed(db)
    d = client.get("/api/reports/month/2026-10").json()
    assert d["is_complete"] is False
    assert (d["days_elapsed"], d["days_in_month"]) == (4, 31)
    assert d["expenses"] == "0.00"
    assert d["average_months"] == 3


def test_no_history_means_no_averages(client: TestClient) -> None:
    d = client.get("/api/reports/month/2026-09").json()
    assert d["average_months"] == 0
    assert d["income_average"] is None
    assert d["savings_rate"] is None


def test_future_and_invalid_months_rejected(client: TestClient) -> None:
    assert client.get("/api/reports/month/2026-11").status_code == 400
    assert client.get("/api/reports/month/2026-13").status_code == 400
    assert client.get("/api/reports/month/sept").status_code == 422
