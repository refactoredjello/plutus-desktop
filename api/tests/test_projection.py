from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import BalanceSnapshot, ManualEntry, RecurringCharge
from app.models.base import AccountType, Cadence, Recurrence, RecurrenceStatus
from app.services import schedule
from app.services.projection import project
from tests.factories import make_account, make_tx

TODAY = date(2026, 10, 15)  # Thursday; 16 days remain in October


@pytest.fixture(autouse=True)
def fixed_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(schedule, "today", lambda: TODAY)


def charge(
    db: Session,
    account_id: int,
    key: str,
    amount: str,
    cadence: Cadence,
    nxt: date,
    status: RecurrenceStatus = RecurrenceStatus.CONFIRMED,
) -> None:
    db.add(
        RecurringCharge(
            merchant_key=key,
            account_id=account_id,
            amount=Decimal(amount),
            cadence=cadence,
            next_expected_date=nxt,
            status=status,
        )
    )


def entry(
    db: Session, amount: str, due: date, rec: Recurrence = Recurrence.NONE, **kw: object
) -> None:
    db.add(ManualEntry(amount=Decimal(amount), description="x", due_date=due, recurrence=rec, **kw))


def test_projection_hand_computed(client: TestClient, db: Session) -> None:
    chk = make_account(db, AccountType.CHECKING)
    cc = make_account(db, AccountType.CREDIT)
    now = datetime(2026, 10, 15, tzinfo=UTC)
    db.add(BalanceSnapshot(account_id=chk.id, balance=Decimal("5000.00"), as_of=now))
    db.add(BalanceSnapshot(account_id=cc.id, balance=Decimal("-1000.00"), as_of=now))

    charge(db, chk.id, "payroll", "2000.00", Cadence.BIWEEKLY, date(2026, 10, 16))
    charge(db, chk.id, "rent", "-1500.00", Cadence.MONTHLY, date(2026, 11, 1))
    charge(db, chk.id, "netflix", "-15.00", Cadence.MONTHLY, date(2026, 10, 20))
    charge(
        db,
        chk.id,
        "proposed",
        "-99.00",
        Cadence.MONTHLY,
        date(2026, 10, 18),
        RecurrenceStatus.PROPOSED,
    )

    entry(db, "-200.00", date(2026, 10, 25))
    entry(db, "-30.00", date(2026, 10, 31), Recurrence.MONTHLY)
    entry(db, "10.00", date(2026, 10, 16), Recurrence.WEEKLY, end_date=date(2026, 10, 23))
    entry(db, "-77.00", date(2026, 10, 10))  # already past
    paid = make_tx(db, chk, "-500.00", "PAID", date(2026, 10, 12))
    entry(db, "-500.00", date(2026, 10, 28), fulfilled_transaction_id=paid.id)

    # Variable spending: Netflix (confirmed recurring), the transfer, income and old spend are out.
    make_tx(db, chk, "-900.00", "GROCER", date(2026, 9, 1))
    make_tx(db, chk, "-15.00", "NETFLIX", date(2026, 9, 20), merchant_key="netflix")
    make_tx(db, chk, "-500.00", "TO SAVINGS", date(2026, 9, 5), is_transfer=True)
    make_tx(db, chk, "-1000.00", "OLD", date(2026, 7, 10))  # outside the 90 days
    # income is not spending; it belongs to the confirmed payroll, so no variable income either
    make_tx(db, chk, "3000.00", "PAYROLL", date(2026, 9, 25), merchant_key="payroll")
    db.flush()

    body = client.get("/api/projection").json()
    assert body["as_of"] == "2026-10-15"
    assert body["current_balance"] == "4000.00"
    assert [m["month"] for m in body["months"]] == ["2026-10", "2026-11", "2026-12"]
    # Variable spending counts the 900 grocery and the 500 "PAID" expense: 1400 over 90 days.
    rows = [{k: v for k, v in m.items() if k != "month"} for m in body["months"]]
    assert rows[0] == {
        "starting_balance": "4000.00",
        "recurring_income": "4000.00",  # Oct 16 + Oct 30
        "recurring_expenses": "15.00",
        "manual_income": "20.00",
        "manual_expenses": "230.00",
        "variable_spending": "248.89",  # 1400 / 90 * 16
        "variable_income": "0.00",
        "projected_end_balance": "7526.11",
    }
    assert rows[1] == {
        "starting_balance": "7526.11",
        "recurring_income": "4000.00",  # Nov 13 + Nov 27
        "recurring_expenses": "1515.00",
        "manual_income": "0.00",
        "manual_expenses": "30.00",  # Nov 30
        "variable_spending": "466.67",  # 1400 / 90 * 30
        "variable_income": "0.00",
        "projected_end_balance": "9514.44",
    }
    assert rows[2]["variable_spending"] == "482.22"  # 1400 / 90 * 31
    assert rows[2]["projected_end_balance"] == "11487.22"
    text = " ".join(body["assumptions"])
    assert "$15.56/day" in text
    assert "3 confirmed recurring items" in text
    assert "3 planned manual entries" in text


def test_projection_months_param_and_empty_database(client: TestClient) -> None:
    body = client.get("/api/projection", params={"months": 2}).json()
    assert body["current_balance"] == "0.00"
    assert len(body["months"]) == 2
    assert body["months"][1]["projected_end_balance"] == "0.00"


def test_projection_rolls_over_the_year(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(schedule, "today", lambda: date(2026, 12, 31))
    months = client.get("/api/projection", params={"months": 2}).json()["months"]
    assert [m["month"] for m in months] == ["2026-12", "2027-01"]


def test_stale_next_date_rolls_forward(client: TestClient, db: Session) -> None:
    chk = make_account(db)
    charge(db, chk.id, "old", "-10.00", Cadence.MONTHLY, date(2026, 8, 31))
    db.flush()
    months = client.get("/api/projection", params={"months": 2}).json()["months"]
    assert months[0]["recurring_expenses"] == "10.00"  # Oct 31 (clamped series from Aug 31)
    assert months[1]["recurring_expenses"] == "10.00"  # Nov 30


def test_schedule_occurrences() -> None:
    got = list(
        schedule.occurrences(
            date(2026, 1, 31), Recurrence.MONTHLY, date(2026, 1, 31), date(2026, 4, 30)
        )
    )
    assert got == [date(2026, 2, 28), date(2026, 3, 31), date(2026, 4, 30)]
    assert (
        list(
            schedule.occurrences(
                date(2026, 1, 1), Recurrence.NONE, date(2026, 1, 1), date(2026, 2, 1)
            )
        )
        == []
    )


def test_lapsed_recurrence_is_left_out_but_recent_one_rolls_forward(
    client: TestClient, db: Session
) -> None:
    chk = make_account(db)
    make_tx(db, chk, "-1.00", "OLD", date(2026, 1, 1))  # keep a full 90-day window
    # Monthly: limit is 2 * 30 + 7 = 67 days. Last seen 66 days ago is live, 68 days is lapsed.
    charge(db, chk.id, "live", "-10.00", Cadence.MONTHLY, date(2026, 9, 1))
    charge(db, chk.id, "dead", "-20.00", Cadence.MONTHLY, date(2026, 9, 1))
    live, dead = db.query(RecurringCharge).order_by(RecurringCharge.merchant_key).all()[::-1]
    live.last_seen_on = TODAY - timedelta(days=66)
    dead.last_seen_on = TODAY - timedelta(days=68)
    db.flush()
    body = client.get("/api/projection", params={"months": 2}).json()
    assert body["months"][0]["recurring_expenses"] == "0.00"  # Oct 1 already passed
    assert body["months"][1]["recurring_expenses"] == "10.00"  # rolled to Nov 1
    text = " ".join(body["assumptions"])
    assert "1 confirmed recurring item(s) left out" in text
    assert "1 confirmed recurring item is included" in text


def test_short_history_divides_by_days_covered(client: TestClient, db: Session) -> None:
    chk = make_account(db)
    make_tx(db, chk, "-300.00", "GROCER", TODAY - timedelta(days=30))
    make_tx(db, chk, "-600.00", "BIG TRANSFER", TODAY - timedelta(days=100), is_transfer=True)
    body = client.get("/api/projection", params={"months": 1}).json()
    # Earliest non-transfer is 30 days ago: 300 / 30 = 10.00/day over 16 days.
    assert body["months"][0]["variable_spending"] == "160.00"
    assert "$10.00/day over the last 30 days (all the history there is)" in " ".join(
        body["assumptions"]
    )


def test_unconfirmed_income_is_projected_through_the_average(db: Session) -> None:
    chk = make_account(db)
    db.add(
        BalanceSnapshot(
            account_id=chk.id, balance=Decimal("1000.00"), as_of=datetime(2026, 10, 15, tzinfo=UTC)
        )
    )
    # A paycheck that is not (yet) a confirmed recurrence, and some spending.
    make_tx(db, chk, "2700.00", "PAYROLL", date(2026, 9, 30), merchant_key="acme payroll")
    make_tx(db, chk, "-900.00", "GROCER", date(2026, 9, 1))
    make_tx(db, chk, "-1.00", "OLD", date(2026, 6, 1))  # history older than 90 days
    db.flush()
    october = project(db, months=1).months[0]
    assert october.variable_income == Decimal("480.00")  # 2700 / 90 * 16
    assert october.variable_spending == Decimal("160.00")  # 900 / 90 * 16
    assert october.projected_end_balance == Decimal("1320.00")


def test_semimonthly_counts_two_paychecks_per_full_month(client: TestClient, db: Session) -> None:
    chk = make_account(db)
    charge(db, chk.id, "payroll", "1500.00", Cadence.SEMIMONTHLY, date(2026, 10, 31))
    db.flush()
    months = client.get("/api/projection", params={"months": 3}).json()["months"]
    # Oct 31 (only one left in Oct), Nov 15 + Nov 30, Dec 15 + Dec 31.
    assert [m["recurring_income"] for m in months] == ["1500.00", "3000.00", "3000.00"]


def test_semimonthly_annual_cost_and_lapse(client: TestClient, db: Session) -> None:
    chk = make_account(db)
    charge(db, chk.id, "payroll", "1500.00", Cadence.SEMIMONTHLY, date(2026, 10, 15))
    db.flush()
    body = client.get("/api/recurring").json()
    assert body[0]["annual_cost"] == "36000.00"
    row = db.query(RecurringCharge).one()
    row.last_seen_on = TODAY - timedelta(days=38)  # limit is 2 * 15 + 7 = 37
    db.flush()
    months = client.get("/api/projection", params={"months": 1}).json()["months"]
    assert months[0]["recurring_income"] == "0.00"


def test_one_time_expenses_are_left_out_of_the_average(client: TestClient, db: Session) -> None:
    chk = make_account(db)
    make_tx(db, chk, "-300.00", "GROCER", TODAY - timedelta(days=30))
    make_tx(db, chk, "-9000.00", "PARKING FINE", TODAY - timedelta(days=20), one_time=True)
    body = client.get("/api/projection", params={"months": 1}).json()
    # Only the groceries count: 300 / 30 = 10.00/day over 16 days.
    assert body["months"][0]["variable_spending"] == "160.00"
    assert "one-time transactions" in " ".join(body["assumptions"])
