from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import BalanceSnapshot
from app.models.base import AccountType, Essentiality
from app.services import schedule
from tests.factories import make_account, make_tx
from tests.test_aggregates import categorize

TODAY = date(2026, 3, 15)


@pytest.fixture(autouse=True)
def fixed_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(schedule, "today", lambda: TODAY)


def snapshot(db: Session, account_id: int, balance: str, day: date) -> None:
    db.add(
        BalanceSnapshot(
            account_id=account_id,
            balance=Decimal(balance),
            as_of=datetime(day.year, day.month, day.day, 12, tzinfo=UTC),
        )
    )
    db.flush()


def test_monthly_maps_totals_and_net(client: TestClient, db: Session) -> None:
    chk = make_account(db)
    salary = make_tx(db, chk, "3000.00", "PAYROLL", date(2026, 3, 1))
    categorize(db, salary.id, "INCOME_SALARY")
    rent = make_tx(db, chk, "-2000.00", "RENT", date(2026, 3, 2))
    categorize(db, rent.id, "RENT_AND_UTILITIES_RENT", Essentiality.ESSENTIAL)

    body = client.get("/api/reports/monthly", params={"months": 2}).json()
    assert [m["month"] for m in body] == ["2026-02", "2026-03"]
    assert body[0]["income"] == "0.00"
    assert body[1] == {
        "month": "2026-03",
        "income": "3000.00",
        "expenses": "2000.00",
        "net": "1000.00",
        "essential": "2000.00",
        "flexible": "0.00",
        "discretionary": "0.00",
        "uncategorized": "0.00",
    }


def test_by_category_maps_totals(client: TestClient, db: Session) -> None:
    chk = make_account(db)
    tx = make_tx(db, chk, "-40.00", "COFFEE", date(2026, 3, 3))
    categorize(db, tx.id, "FOOD_AND_DRINK_COFFEE", Essentiality.DISCRETIONARY)
    make_tx(db, chk, "-10.00", "MYSTERY", date(2026, 3, 4))

    body = client.get("/api/reports/by-category", params={"month": "2026-03"}).json()
    assert [(c["total"], c["count"]) for c in body] == [("40.00", 1), ("10.00", 1)]
    assert body[1]["category_id"] is None
    assert body[1]["label"] == "Uncategorized"


def test_by_category_rejects_bad_month(client: TestClient) -> None:
    assert client.get("/api/reports/by-category", params={"month": "2026-13"}).status_code == 400
    assert client.get("/api/reports/by-category", params={"month": "March"}).status_code == 422


def test_balances_reconstruct_from_latest_snapshot(client: TestClient, db: Session) -> None:
    chk = make_account(db, AccountType.CHECKING, "Checking")
    snapshot(db, chk.id, "999.00", date(2026, 10, 1))  # older snapshot is ignored
    snapshot(db, chk.id, "1000.00", date(2026, 10, 10))
    make_tx(db, chk, "-200.00", posted_on=date(2026, 10, 5))
    make_tx(db, chk, "-100.00", posted_on=date(2026, 10, 8))
    make_tx(db, chk, "50.00", posted_on=date(2026, 10, 10))
    cc = make_account(db, AccountType.CREDIT, "Card")
    snapshot(db, cc.id, "-500.00", date(2026, 10, 12))
    make_tx(db, cc, "-100.00", posted_on=date(2026, 10, 11))
    make_tx(db, cc, "300.00", posted_on=date(2026, 10, 12))
    make_account(db, name="No snapshots")

    body = client.get("/api/reports/balances", params={"start": "2026-10-04", "end": "2026-10-13"})
    series = {s["name"]: {p["on"]: p["balance"] for p in s["points"]} for s in body.json()}
    assert set(series) == {"Checking", "Card"}
    assert len(series["Checking"]) == 10
    assert series["Checking"] == {
        "2026-10-04": "1250.00",
        "2026-10-05": "1050.00",
        "2026-10-06": "1050.00",
        "2026-10-07": "1050.00",
        "2026-10-08": "950.00",
        "2026-10-09": "950.00",
        "2026-10-10": "1000.00",
        "2026-10-11": "1000.00",  # after the snapshot day: carried
        "2026-10-12": "1000.00",
        "2026-10-13": "1000.00",
    }
    assert series["Card"]["2026-10-10"] == "-700.00"
    assert series["Card"]["2026-10-11"] == "-800.00"
    assert series["Card"]["2026-10-12"] == "-500.00"
    assert series["Card"]["2026-10-13"] == "-500.00"


def test_balances_default_to_180_days_ending_today(client: TestClient, db: Session) -> None:
    chk = make_account(db)
    snapshot(db, chk.id, "100.00", TODAY)
    points = client.get("/api/reports/balances").json()[0]["points"]
    assert len(points) == 181
    assert points[0]["on"] == "2025-09-16"
    assert points[-1]["on"] == "2026-03-15"
