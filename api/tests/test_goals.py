from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import BalanceSnapshot, Goal
from app.services import schedule
from app.services.goals import months_between
from tests.factories import make_account, make_tx

TODAY = date(2026, 10, 15)


@pytest.fixture(autouse=True)
def frozen_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(schedule, "today", lambda: TODAY)


def set_balance(db: Session, account_id: int, balance: str) -> None:
    db.add(
        BalanceSnapshot(account_id=account_id, balance=Decimal(balance), as_of=datetime.now(UTC))
    )
    db.flush()


@pytest.mark.parametrize(
    ("start", "end", "expected"),
    [
        (date(2026, 10, 15), date(2027, 10, 15), 12),
        (date(2026, 10, 15), date(2027, 10, 14), 11),
        (date(2026, 10, 31), date(2026, 11, 30), 0),
        (date(2026, 10, 15), date(2026, 11, 15), 1),
        (date(2026, 10, 15), date(2026, 10, 20), 0),
        (date(2026, 10, 15), date(2026, 10, 15), 0),
        (date(2026, 10, 15), date(2026, 9, 1), 0),
        (date(2026, 12, 20), date(2027, 2, 20), 2),
    ],
)
def test_months_between(start: date, end: date, expected: int) -> None:
    assert months_between(start, end) == expected


def test_progress_hand_computed(client: TestClient, db: Session) -> None:
    acct = make_account(db)
    set_balance(db, acct.id, "10000.00")
    r = client.post(
        "/api/goals", json={"name": "Trip", "target_amount": "6000", "target_date": "2027-04-15"}
    )
    assert r.status_code == 201
    goal = r.json()
    assert goal["starting_amount"] == "10000.00"

    # Balance grows 1500; last three complete months are Jul, Aug, Sep 2026.
    set_balance(db, acct.id, "11500.00")
    make_tx(db, acct, "3000", "PAYROLL", date(2026, 7, 5))
    make_tx(db, acct, "3000", "PAYROLL", date(2026, 8, 5))
    make_tx(db, acct, "3000", "PAYROLL", date(2026, 9, 5))
    make_tx(db, acct, "-2400", "RENT", date(2026, 7, 6))
    make_tx(db, acct, "-2400", "RENT", date(2026, 8, 6))
    make_tx(db, acct, "-2250", "RENT", date(2026, 9, 6))
    # Current month is incomplete and must not count.
    make_tx(db, acct, "-5000", "BIG", date(2026, 10, 2))

    p = client.get(f"/api/goals/{goal['id']}").json()["progress"]
    assert p == {
        "saved_so_far": "1500.00",
        "remaining": "4500.00",
        "months_left": 6,
        "required_monthly": "750.00",
        "actual_monthly_average": "650.00",  # (600 + 600 + 750) / 3
        "on_track": False,
    }


def test_progress_on_track_and_overshoot(client: TestClient, db: Session) -> None:
    acct = make_account(db)
    set_balance(db, acct.id, "0.00")
    gid = client.post(
        "/api/goals", json={"name": "G", "target_amount": "100", "target_date": "2026-10-20"}
    ).json()["id"]
    set_balance(db, acct.id, "500.00")
    p = client.get(f"/api/goals/{gid}").json()["progress"]
    assert p["remaining"] == "0.00"
    assert p["months_left"] == 0
    assert p["required_monthly"] == "0.00"
    assert p["on_track"] is True


def test_target_date_must_be_future(client: TestClient) -> None:
    for d in ("2026-10-15", "2020-01-01"):
        r = client.post("/api/goals", json={"name": "G", "target_amount": "10", "target_date": d})
        assert r.status_code == 400


def test_list_active_first_then_target_date(client: TestClient) -> None:
    def make(name: str, d: str) -> int:
        body = {"name": name, "target_amount": "10", "target_date": d}
        return int(client.post("/api/goals", json=body).json()["id"])

    late = make("late", "2028-01-01")
    early = make("early", "2027-01-01")
    done = make("done", "2026-12-01")
    client.patch(f"/api/goals/{done}", json={"is_active": False})
    assert [g["id"] for g in client.get("/api/goals").json()] == [early, late, done]


def test_patch_goal(client: TestClient, db: Session) -> None:
    gid = client.post(
        "/api/goals", json={"name": "G", "target_amount": "10", "target_date": "2027-01-01"}
    ).json()["id"]
    r = client.patch(f"/api/goals/{gid}", json={"name": "Renamed", "target_amount": "20"})
    assert r.json()["name"] == "Renamed"
    assert r.json()["target_amount"] == "20.00"
    assert r.json()["target_date"] == "2027-01-01"
    assert client.patch(f"/api/goals/{gid}", json={"target_date": "2026-01-01"}).status_code == 400
    assert client.patch(f"/api/goals/{gid}", json={"name": None}).status_code == 400
    assert db.get(Goal, gid) is not None


def test_goal_404s(client: TestClient) -> None:
    assert client.get("/api/goals/999999").status_code == 404
    assert client.patch("/api/goals/999999", json={"name": "x"}).status_code == 404
