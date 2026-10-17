from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Account, RecurringCharge
from app.models.base import AccountType, Cadence, Essentiality, RecurrenceStatus
from app.services import schedule
from app.services.recurring import detect_recurring
from app.services.schedule import add_months
from tests.factories import make_account, make_tx
from tests.test_aggregates import categorize


def series(
    db: Session, account: Account, key: str, amounts: list[str], dates: list[date], **kw: object
) -> None:
    for amount, day in zip(amounts, dates, strict=True):
        make_tx(db, account, amount, key.upper(), day, merchant_key=key, **kw)


def only(db: Session) -> RecurringCharge:
    return db.scalars(select(RecurringCharge)).one()


def test_detects_monthly(db: Session) -> None:
    acct = make_account(db)
    series(
        db,
        acct,
        "netflix",
        ["-15.49", "-15.49", "-15.99"],
        [date(2026, 7, 15), date(2026, 8, 15), date(2026, 9, 14)],
    )
    assert detect_recurring(db) == 1
    r = only(db)
    assert (r.cadence, r.status) == (Cadence.MONTHLY, RecurrenceStatus.PROPOSED)
    assert r.amount == Decimal("-15.49")  # median of the last three
    assert r.last_seen_on == date(2026, 9, 14)
    assert r.next_expected_date == date(2026, 10, 14)
    assert r.essentiality is None


def test_monthly_next_date_clamps_to_month_end(db: Session) -> None:
    acct = make_account(db)
    series(
        db,
        acct,
        "gym",
        ["-30.00"] * 3,
        [date(2026, 11, 30), date(2026, 12, 31), date(2027, 1, 31)],
    )
    detect_recurring(db)
    assert only(db).next_expected_date == date(2027, 2, 28)
    assert add_months(date(2028, 1, 31), 1) == date(2028, 2, 29)


def test_detects_biweekly_income(db: Session) -> None:
    acct = make_account(db)
    start = date(2026, 8, 7)
    series(
        db,
        acct,
        "acme payroll",
        ["2000.00"] * 4,
        [start + timedelta(days=14 * i) for i in range(4)],
    )
    detect_recurring(db)
    r = only(db)
    assert (r.cadence, r.amount) == (Cadence.BIWEEKLY, Decimal("2000.00"))
    assert r.next_expected_date == date(2026, 10, 2)


def test_detects_weekly(db: Session) -> None:
    acct = make_account(db)
    start = date(2026, 9, 1)
    series(
        db, acct, "lunch club", ["-12.00"] * 4, [start + timedelta(days=7 * i) for i in range(4)]
    )
    detect_recurring(db)
    assert only(db).cadence == Cadence.WEEKLY


def test_needs_three_occurrences(db: Session) -> None:
    acct = make_account(db)
    series(db, acct, "x", ["-9.00"] * 2, [date(2026, 8, 1), date(2026, 9, 1)])
    assert detect_recurring(db) == 0


def test_inconsistent_gaps_rejected(db: Session) -> None:
    acct = make_account(db)
    series(
        db,
        acct,
        "random",
        ["-10.00"] * 4,
        [date(2026, 1, 1), date(2026, 1, 5), date(2026, 3, 1), date(2026, 3, 4)],
    )
    assert detect_recurring(db) == 0
    assert db.scalars(select(RecurringCharge)).all() == []


def test_one_outlier_gap_in_many_is_tolerated(db: Session) -> None:
    acct = make_account(db)
    days = [
        date(2026, 1, 5),
        date(2026, 2, 5),
        date(2026, 3, 5),
        date(2026, 3, 20),
        date(2026, 4, 20),
    ]
    series(db, acct, "mostly monthly", ["-10.00"] * 5, days)
    assert detect_recurring(db) == 1


def test_amount_swing_over_15_percent_rejected(db: Session) -> None:
    acct = make_account(db)
    series(
        db,
        acct,
        "utility",
        ["-10.00", "-10.00", "-13.00"],
        [date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)],
    )
    assert detect_recurring(db) == 0


def test_occasional_outlier_amount_still_detected(db: Session) -> None:
    """Owner-like paychecks: 7 regular, one bonus, one double payment."""
    acct = make_account(db)
    amounts = ["2740.00", "2000.00", "2000.00", "2000.00", "2000.00", "4100.00"]
    amounts += ["2000.00", "2000.00", "2000.00"]
    days = [date(2026, 5, 15), date(2026, 5, 29), date(2026, 6, 15), date(2026, 6, 30)]
    days += [date(2026, 7, 15), date(2026, 7, 31), date(2026, 8, 14), date(2026, 8, 31)]
    days += [date(2026, 9, 15)]
    series(db, acct, "acme payroll", amounts, days)
    assert detect_recurring(db) == 1
    row = db.scalars(select(RecurringCharge)).one()
    assert row.cadence is Cadence.SEMIMONTHLY
    assert row.amount == Decimal("2000.00")


def test_reversal_in_the_same_merchant_does_not_hide_a_paycheck(db: Session) -> None:
    acct = make_account(db)
    days = [date(2026, m, d) for m in (6, 7, 8) for d in (15, 28)]
    series(db, acct, "acme payroll", ["2000.00"] * len(days), days)
    series(db, acct, "acme payroll", ["-35.00"], [date(2026, 6, 3)])  # a correction
    assert detect_recurring(db) == 1
    assert db.scalars(select(RecurringCharge)).one().amount == Decimal("2000.00")


def test_transfers_and_pending_ignored(db: Session) -> None:
    acct = make_account(db)
    days = [date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)]
    series(db, acct, "xfer", ["-50.00"] * 3, days, is_transfer=True)
    series(db, acct, "pend", ["-50.00"] * 3, days, pending=True)
    assert detect_recurring(db) == 0


def test_same_merchant_on_two_accounts_is_two_groups(db: Session) -> None:
    a, b = make_account(db), make_account(db)
    days = [date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)]
    series(db, a, "spotify", ["-10.00"] * 3, days)
    series(db, b, "spotify", ["-10.00"] * 3, days)
    assert detect_recurring(db) == 2


def test_essentiality_from_latest_categorization(db: Session) -> None:
    acct = make_account(db)
    series(
        db, acct, "netflix", ["-15.00"] * 3, [date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)]
    )
    txs = db.scalars(select(RecurringCharge.id)).all()
    assert txs == []
    from app.models import Transaction

    ids = db.scalars(select(Transaction.id).order_by(Transaction.posted_on)).all()
    categorize(db, ids[0], "ENTERTAINMENT_TV_AND_MOVIES", Essentiality.FLEXIBLE)
    categorize(db, ids[2], "ENTERTAINMENT_TV_AND_MOVIES", Essentiality.DISCRETIONARY)
    detect_recurring(db)
    assert only(db).essentiality == Essentiality.DISCRETIONARY


def test_dismissed_is_never_touched_or_recreated(db: Session) -> None:
    acct = make_account(db)
    series(
        db, acct, "netflix", ["-15.00"] * 3, [date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)]
    )
    db.add(
        RecurringCharge(
            merchant_key="netflix",
            account_id=acct.id,
            amount=Decimal("-1.00"),
            cadence=Cadence.WEEKLY,
            next_expected_date=date(2026, 1, 1),
            status=RecurrenceStatus.DISMISSED,
        )
    )
    db.flush()
    assert detect_recurring(db) == 0
    r = only(db)
    assert (r.status, r.amount, r.cadence, r.next_expected_date) == (
        RecurrenceStatus.DISMISSED,
        Decimal("-1.00"),
        Cadence.WEEKLY,
        date(2026, 1, 1),
    )


def test_confirmed_keeps_status_but_refreshes(db: Session) -> None:
    acct = make_account(db)
    series(
        db, acct, "netflix", ["-15.00"] * 3, [date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)]
    )
    db.add(
        RecurringCharge(
            merchant_key="netflix",
            account_id=acct.id,
            amount=Decimal("-14.00"),
            cadence=Cadence.MONTHLY,
            next_expected_date=date(2026, 9, 1),
            last_seen_on=date(2026, 8, 1),
            status=RecurrenceStatus.CONFIRMED,
            essentiality=Essentiality.ESSENTIAL,
        )
    )
    db.flush()
    assert detect_recurring(db) == 1
    r = only(db)
    assert r.status == RecurrenceStatus.CONFIRMED
    assert r.amount == Decimal("-15.00")
    assert r.last_seen_on == date(2026, 9, 1)
    assert r.next_expected_date == date(2026, 10, 1)
    assert r.essentiality == Essentiality.ESSENTIAL
    assert detect_recurring(db) == 0  # idempotent


def make_charge(
    db: Session, key: str, amount: str, status: RecurrenceStatus, cadence: Cadence = Cadence.MONTHLY
) -> RecurringCharge:
    acct = make_account(db)
    charge = RecurringCharge(
        merchant_key=key,
        account_id=acct.id,
        amount=Decimal(amount),
        cadence=cadence,
        next_expected_date=date(2026, 10, 20),
        last_seen_on=date(2026, 9, 20),
        status=status,
    )
    db.add(charge)
    db.flush()
    return charge


def test_list_defaults_to_proposed_and_confirmed(client: TestClient, db: Session) -> None:
    make_charge(db, "a", "-10.00", RecurrenceStatus.PROPOSED)
    make_charge(db, "b", "-20.00", RecurrenceStatus.CONFIRMED)
    make_charge(db, "c", "-30.00", RecurrenceStatus.DISMISSED)
    body = client.get("/api/recurring").json()
    assert sorted(r["merchant_key"] for r in body) == ["a", "b"]
    only_dismissed = client.get("/api/recurring", params={"status": "dismissed"}).json()
    assert [r["merchant_key"] for r in only_dismissed] == ["c"]


def test_annual_cost_is_signed(client: TestClient, db: Session) -> None:
    make_charge(db, "rent", "-100.00", RecurrenceStatus.CONFIRMED, Cadence.MONTHLY)
    make_charge(db, "pay", "1000.00", RecurrenceStatus.CONFIRMED, Cadence.BIWEEKLY)
    make_charge(db, "gym", "-5.00", RecurrenceStatus.CONFIRMED, Cadence.WEEKLY)
    make_charge(db, "ins", "-300.00", RecurrenceStatus.CONFIRMED, Cadence.YEARLY)
    costs = {r["merchant_key"]: r["annual_cost"] for r in client.get("/api/recurring").json()}
    assert costs == {"rent": "-1200.00", "pay": "26000.00", "gym": "-260.00", "ins": "-300.00"}


def test_patch_updates_fields(client: TestClient, db: Session) -> None:
    charge = make_charge(db, "a", "-10.00", RecurrenceStatus.PROPOSED)
    resp = client.patch(
        f"/api/recurring/{charge.id}",
        json={"status": "confirmed", "essentiality": "flexible", "amount": "-12.50"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert (body["status"], body["essentiality"], body["amount"]) == (
        "confirmed",
        "flexible",
        "-12.50",
    )
    assert body["next_expected_date"] == "2026-10-20"  # unchanged without a cadence change
    cleared = client.patch(f"/api/recurring/{charge.id}", json={"essentiality": None}).json()
    assert cleared["essentiality"] is None


def test_patch_cadence_recomputes_next_date(client: TestClient, db: Session) -> None:
    charge = make_charge(db, "a", "-10.00", RecurrenceStatus.CONFIRMED)
    body = client.patch(f"/api/recurring/{charge.id}", json={"cadence": "weekly"}).json()
    assert body["cadence"] == "weekly"
    assert body["next_expected_date"] == "2026-09-27"


def test_patch_unknown_is_404(client: TestClient) -> None:
    assert client.patch("/api/recurring/999999", json={"status": "confirmed"}).status_code == 404


def test_history_older_than_18_months_is_ignored(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(schedule, "today", lambda: date(2026, 10, 3))
    acct = make_account(db)
    series(db, acct, "old", ["-10.00"] * 3, [date(2025, 1, 5), date(2025, 2, 5), date(2025, 3, 5)])
    assert detect_recurring(db) == 0
    series(
        db, acct, "recent", ["-10.00"] * 3, [date(2026, 7, 5), date(2026, 8, 5), date(2026, 9, 5)]
    )
    assert detect_recurring(db) == 1


def month_ends_and_fifteenths(start_year: int, start_month: int, months: int) -> list[date]:
    out: list[date] = []
    for i in range(months):
        first = add_months(date(start_year, start_month, 1), i)
        out.append(first.replace(day=15))
        out.append(add_months(first, 1) - timedelta(days=1))
    return out


def test_detects_semimonthly_owner_like_gaps(db: Session) -> None:
    acct = make_account(db)
    days = month_ends_and_fifteenths(2026, 1, 9)  # Jan 15 ... Sep 30
    series(db, acct, "acme payroll", ["2500.00"] * len(days), days)
    detect_recurring(db)
    r = only(db)
    assert r.cadence == Cadence.SEMIMONTHLY
    assert r.amount == Decimal("2500.00")
    assert r.next_expected_date == date(2026, 10, 15)


def test_semimonthly_with_jittered_pay_days(db: Session) -> None:
    acct = make_account(db)
    days = [
        date(2026, 6, 15), date(2026, 6, 30), date(2026, 7, 15), date(2026, 7, 31),
        date(2026, 8, 14), date(2026, 8, 31), date(2026, 9, 15), date(2026, 9, 30),
    ]  # fmt: skip
    series(db, acct, "acme payroll", ["2500.00"] * len(days), days)
    detect_recurring(db)
    assert only(db).cadence == Cadence.SEMIMONTHLY


def test_true_biweekly_is_not_semimonthly(db: Session) -> None:
    acct = make_account(db)
    start = date(2026, 3, 6)
    days = [start + timedelta(days=14 * i) for i in range(12)]
    series(db, acct, "acme payroll", ["2000.00"] * len(days), days)
    detect_recurring(db)
    assert only(db).cadence == Cadence.BIWEEKLY


def test_semimonthly_next_dates_alternate_and_clamp() -> None:
    from app.services.schedule import next_after

    assert next_after(date(2026, 9, 15), Cadence.SEMIMONTHLY) == date(2026, 9, 30)
    assert next_after(date(2026, 9, 30), Cadence.SEMIMONTHLY) == date(2026, 10, 15)
    assert next_after(date(2026, 2, 15), Cadence.SEMIMONTHLY) == date(2026, 2, 28)
    assert next_after(date(2026, 2, 28), Cadence.SEMIMONTHLY) == date(2026, 3, 15)
    assert next_after(date(2026, 12, 31), Cadence.SEMIMONTHLY) == date(2027, 1, 15)
    assert next_after(date(2026, 9, 1), Cadence.SEMIMONTHLY) == date(2026, 9, 16)
    assert next_after(date(2026, 9, 16), Cadence.SEMIMONTHLY) == date(2026, 10, 1)


def test_mark_yearly_fee_as_recurring_and_keep_it_current(client: TestClient, db: Session) -> None:
    acct = make_account(db, AccountType.CREDIT)
    fee = make_tx(
        db,
        acct,
        "-325.00",
        "RENEWAL MEMBERSHIP FEE",
        date(2026, 9, 16),
        merchant_key="RENEWAL MEMBERSHIP FEE",
    )
    db.flush()
    res = client.post("/api/recurring", json={"transaction_id": fee.id, "cadence": "yearly"})
    assert res.status_code == 201
    body = res.json()
    assert (body["status"], body["cadence"], body["amount"]) == ("confirmed", "yearly", "-325.00")
    assert body["next_expected_date"] == "2027-09-16"
    assert body["annual_cost"] == "-325.00"
    # Next year's renewal: one occurrence isn't detectable, but the confirmed row stays current.
    make_tx(
        db,
        acct,
        "-350.00",
        "RENEWAL MEMBERSHIP FEE",
        date(2027, 9, 15),
        merchant_key="RENEWAL MEMBERSHIP FEE",
    )
    db.flush()
    detect_recurring(db)
    row = db.scalars(select(RecurringCharge)).one()
    assert row.last_seen_on == date(2027, 9, 15)
    assert row.next_expected_date == date(2028, 9, 15)
    assert row.status is RecurrenceStatus.CONFIRMED


def test_mark_recurring_confirms_a_dismissed_one_and_rejects_transfers(
    client: TestClient, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(schedule, "today", lambda: date(2026, 9, 20))
    acct = make_account(db)
    tx = make_tx(db, acct, "-4.99", "AMAZON PRIME", date(2026, 9, 3), merchant_key="AMAZON PRIME")
    db.add(
        RecurringCharge(
            merchant_key="AMAZON PRIME",
            account_id=acct.id,
            amount=Decimal("-4.99"),
            cadence=Cadence.MONTHLY,
            next_expected_date=date(2026, 10, 3),
            status=RecurrenceStatus.DISMISSED,
        )
    )
    transfer = make_tx(
        db,
        acct,
        "-500.00",
        "TO SAVINGS",
        date(2026, 9, 5),
        is_transfer=True,
        merchant_key="TO SAVINGS",
    )
    db.flush()
    body = client.post(
        "/api/recurring", json={"transaction_id": tx.id, "cadence": "monthly"}
    ).json()
    assert body["status"] == "confirmed"
    assert body["next_expected_date"] == "2026-10-03"
    assert (
        client.post(
            "/api/recurring", json={"transaction_id": transfer.id, "cadence": "monthly"}
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/recurring", json={"transaction_id": 999999, "cadence": "monthly"}
        ).status_code
        == 404
    )
