"""What changed (R12): one positive and one negative case per signal, plus dismissal."""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.models import (
    Account,
    BalanceSnapshot,
    Categorization,
    ChangeDismissal,
    ManualEntry,
    RecurringCharge,
)
from app.models.base import (
    AccountType,
    Cadence,
    Confidence,
    Essentiality,
    Recurrence,
    RecurrenceStatus,
)
from app.services import changes, schedule
from tests.factories import load_simplefin_fixture, make_account, make_tx
from tests.test_aggregates import categorize

TODAY = date(2026, 10, 20)  # in-progress month: day 20 of 31


@pytest.fixture(autouse=True)
def fixed_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(schedule, "today", lambda: TODAY)


def items(db: Session, signal: str) -> list[changes.ChangeItem]:
    return [i for i in changes.compute(db, TODAY, include_all=True).items if i.signal == signal]


def confident(db: Session) -> None:
    """Factory categorizations default to unknown confidence; most tests don't want S7 noise."""
    db.execute(update(Categorization).values(confidence=Confidence.VERY_HIGH))
    db.flush()


def recurrence(
    db: Session, account: Account, key: str, amount: str, **kw: object
) -> RecurringCharge:
    charge = RecurringCharge(
        merchant_key=key,
        account_id=account.id,
        amount=Decimal(amount),
        cadence=kw.pop("cadence", Cadence.MONTHLY),
        next_expected_date=kw.pop("next_expected_date", date(2026, 11, 3)),
        last_seen_on=kw.pop("last_seen_on", date(2026, 10, 3)),
        status=RecurrenceStatus.CONFIRMED,
    )
    db.add(charge)
    db.flush()
    return charge


# --- S1 recurring amount changed ----------------------------------------------------------


def test_s1_recurring_amount_changed(db: Session) -> None:
    acct = make_account(db, AccountType.CREDIT)
    charge = recurrence(db, acct, "NETFLIX.COM CA", "-15.49")
    make_tx(
        db,
        acct,
        "-22.99",
        "NETFLIX.COM",
        date(2026, 10, 3),
        merchant_key="NETFLIX.COM CA",
        payee="Netflix",
    )
    (item,) = items(db, "S1")
    assert item.text == "Netflix went from $15.49 to $22.99."
    assert item.key == f"S1:recurrence:{charge.id}:2299"
    assert item.href == "/recurring"


def test_s1_small_change_ignored(db: Session) -> None:
    acct = make_account(db, AccountType.CREDIT)
    recurrence(db, acct, "NETFLIX.COM CA", "-15.49")
    make_tx(db, acct, "-15.99", "NETFLIX.COM", date(2026, 10, 3), merchant_key="NETFLIX.COM CA")
    assert items(db, "S1") == []


# --- S2 recurring charge missing ----------------------------------------------------------


def test_s2_missing_recurring_charge(db: Session) -> None:
    acct = make_account(db)
    recurrence(
        db,
        acct,
        "PLANET FITNESS",
        "-24.99",
        next_expected_date=date(2026, 10, 5),
        last_seen_on=date(2026, 9, 5),
    )
    (item,) = items(db, "S2")
    assert item.text == "Planet Fitness hasn't posted; expected Oct 5."
    assert item.href == "/recurring"


def test_s2_not_yet_overdue_or_lapsed(db: Session) -> None:
    acct = make_account(db)
    recurrence(
        db,
        acct,
        "WITHIN GRACE",
        "-10.00",
        next_expected_date=date(2026, 10, 15),
        last_seen_on=date(2026, 9, 15),
    )
    recurrence(
        db,
        acct,
        "LONG GONE",
        "-10.00",
        next_expected_date=date(2026, 7, 1),
        last_seen_on=date(2026, 6, 1),
    )
    assert items(db, "S2") == []


# --- S3 planned item overdue --------------------------------------------------------------


def entry(db: Session, amount: str, due: date, **kw: object) -> ManualEntry:
    e = ManualEntry(
        amount=Decimal(amount),
        description=kw.pop("description", "Car insurance"),
        due_date=due,
        **kw,
    )
    db.add(e)
    db.flush()
    return e


def test_s3_planned_item_overdue(db: Session) -> None:
    entry(db, "-412.00", date(2026, 10, 1))
    (item,) = items(db, "S3")
    assert item.text == "Car insurance ($412) was due Oct 1 and hasn't matched a transaction."
    assert item.href == "/planned"


def test_s3_future_fulfilled_or_recurring_ignored(db: Session) -> None:
    acct = make_account(db)
    paid = make_tx(db, acct, "-412.00", "INSURER", date(2026, 10, 1))
    entry(db, "-412.00", date(2026, 10, 1), fulfilled_transaction_id=paid.id)
    entry(db, "-50.00", date(2026, 10, 25))
    entry(db, "-30.00", date(2026, 9, 1), recurrence=Recurrence.MONTHLY)
    assert items(db, "S3") == []


# --- S4 category well above usual ---------------------------------------------------------


def coffee(db: Session, acct: Account, amount: str, day: date) -> None:
    tx = make_tx(db, acct, amount, "COFFEE", day)
    categorize(db, tx.id, "FOOD_AND_DRINK_COFFEE", Essentiality.DISCRETIONARY)


def history(db: Session, acct: Account, monthly: str) -> None:
    for month in (7, 8, 9):
        coffee(db, acct, monthly, date(2026, month, 10))


def test_s4_category_above_usual_pace(db: Session) -> None:
    acct = make_account(db)
    history(db, acct, "-100.00")
    coffee(db, acct, "-200.00", date(2026, 10, 5))
    confident(db)
    (item,) = items(db, "S4")
    # usual by day 20 (history on the 10th): 100; 200 is 100% above it
    assert item.text == "Coffee is $200 so far, 100% above your usual pace."
    assert "start=2026-10-01" in item.href
    assert "end=2026-10-31" in item.href
    assert "category=" in item.href


def test_s4_no_history_or_below_thresholds_ignored(db: Session) -> None:
    acct = make_account(db)
    coffee(db, acct, "-200.00", date(2026, 10, 5))
    confident(db)
    assert items(db, "S4") == []  # no prior months: S4 is skipped (R12.7)


def test_s4_under_dollar_floor_ignored(db: Session) -> None:
    acct = make_account(db)
    history(db, acct, "-150.00")
    coffee(db, acct, "-210.00", date(2026, 10, 5))  # usual 150: 40% above but only $60
    confident(db)
    assert items(db, "S4") == []


def test_s4_under_percentage_ignored(db: Session) -> None:
    acct = make_account(db)
    history(db, acct, "-1000.00")
    coffee(db, acct, "-1200.00", date(2026, 10, 5))  # usual 1000: $200 over but only 20%
    confident(db)
    assert items(db, "S4") == []


# --- S5 new large merchant ----------------------------------------------------------------


def test_s5_new_large_merchant(db: Session) -> None:
    acct = make_account(db)
    tx = make_tx(
        db,
        acct,
        "-486.00",
        "THE HOME DEPOT #123",
        date(2026, 10, 2),
        merchant_key="THE HOME DEPOT",
        payee="Home Depot",
    )
    categorize(db, tx.id, "HOME_IMPROVEMENT_HARDWARE")
    confident(db)
    (item,) = items(db, "S5")
    assert item.text == "First purchase at Home Depot: $486."
    assert "q=Home+Depot" in item.href


def test_s5_known_merchant_or_small_purchase_ignored(db: Session) -> None:
    acct = make_account(db)
    make_tx(db, acct, "-50.00", "THE HOME DEPOT", date(2026, 9, 2), merchant_key="THE HOME DEPOT")
    make_tx(db, acct, "-486.00", "THE HOME DEPOT", date(2026, 10, 2), merchant_key="THE HOME DEPOT")
    make_tx(db, acct, "-150.00", "NEW SHOP", date(2026, 10, 3), merchant_key="NEW SHOP")
    assert items(db, "S5") == []


# --- S6 large single expense --------------------------------------------------------------


def small_expenses(db: Session, acct: Account) -> None:
    for i in range(20):
        make_tx(
            db, acct, "-20.00", "LUNCH", date(2026, 9, 1) + timedelta(days=i), merchant_key="LUNCH"
        )


def test_s6_large_single_expense(db: Session) -> None:
    acct = make_account(db)
    small_expenses(db, acct)
    make_tx(
        db,
        acct,
        "-300.00",
        "DELTA",
        date(2026, 8, 1),
        merchant_key="DELTA AIR LINES",
        payee="Delta Air Lines",
    )
    make_tx(
        db,
        acct,
        "-1200.00",
        "DELTA",
        date(2026, 10, 2),
        merchant_key="DELTA AIR LINES",
        payee="Delta Air Lines",
    )
    (item,) = items(db, "S6")
    assert item.text == "$1,200 to Delta Air Lines on Oct 2."
    assert not items(db, "S5")  # Delta was seen before, so it's S6 not S5


def test_s6_recurring_or_below_floor_ignored(db: Session) -> None:
    acct = make_account(db)
    small_expenses(db, acct)
    recurrence(db, acct, "CONDO FEE", "-1500.00")
    make_tx(db, acct, "-1500.00", "CONDO", date(2026, 10, 1), merchant_key="CONDO FEE")
    make_tx(db, acct, "-240.00", "OLD SHOP", date(2026, 10, 2), merchant_key="LUNCH")  # under $250
    assert items(db, "S6") == []


# --- S7 review backlog --------------------------------------------------------------------


def test_s7_review_backlog_by_count_and_by_size(db: Session) -> None:
    acct = make_account(db)
    for i in range(10):
        make_tx(db, acct, "-5.00", f"MYSTERY {i}", date(2026, 10, 1))
    (item,) = items(db, "S7")
    assert item.text == "10 transactions need review."
    assert item.href == "/review"


def test_s7_single_large_or_quiet_queue(db: Session) -> None:
    acct = make_account(db)
    make_tx(db, acct, "-8.00", "MYSTERY", date(2026, 10, 1))
    assert items(db, "S7") == []
    make_tx(db, acct, "-340.00", "BIG MYSTERY", date(2026, 10, 2))
    (item,) = items(db, "S7")
    assert item.text == "2 transactions need review, including one for $340."


# --- S8 discretionary pace ----------------------------------------------------------------


def test_s8_discretionary_running_above_usual(db: Session) -> None:
    acct = make_account(db)
    history(db, acct, "-300.00")
    coffee(db, acct, "-400.00", date(2026, 10, 5))
    confident(db)
    (item,) = items(db, "S8")
    assert item.text == "Discretionary spending is running 33% above usual."  # 400 vs 300
    assert item.href == "/spending?essentiality=discretionary&month=2026-10"


def test_s8_on_pace_ignored(db: Session) -> None:
    acct = make_account(db)
    history(db, acct, "-300.00")
    coffee(db, acct, "-350.00", date(2026, 10, 5))  # 17% above: under the 25% threshold
    confident(db)
    assert items(db, "S8") == []


# --- S9 projection negative ---------------------------------------------------------------


def balance(db: Session, account: Account, amount: str) -> None:
    db.add(
        BalanceSnapshot(
            account_id=account.id, balance=Decimal(amount), as_of=datetime(2026, 10, 19, tzinfo=UTC)
        )
    )
    db.flush()


def test_s9_projection_negative(db: Session) -> None:
    acct = make_account(db)
    balance(db, acct, "-410.00")
    (item,) = items(db, "S9")
    assert item.text == "Projected month-end balance is \N{MINUS SIGN}$410."
    assert item.href == "/#balance"


def test_s9_positive_projection_ignored(db: Session) -> None:
    acct = make_account(db)
    balance(db, acct, "5000.00")
    assert items(db, "S9") == []


# --- dismissal, ordering, cap, determinism -------------------------------------------------


def test_dismiss_hides_until_fact_changes_and_clear_restores(
    client: TestClient, db: Session
) -> None:
    acct = make_account(db, AccountType.CREDIT)
    recurrence(db, acct, "NETFLIX.COM CA", "-15.49")
    make_tx(db, acct, "-22.99", "NETFLIX.COM", date(2026, 10, 3), merchant_key="NETFLIX.COM CA")
    key = items(db, "S1")[0].key
    assert client.post("/api/reports/changes/dismiss", json={"key": key}).status_code == 204
    signals = lambda: [i["signal"] for i in client.get("/api/reports/changes").json()["items"]]  # noqa: E731
    assert "S1" not in signals()
    make_tx(db, acct, "-25.99", "NETFLIX.COM", date(2026, 10, 10), merchant_key="NETFLIX.COM CA")
    (back,) = items(db, "S1")
    assert back.key != key
    assert "$25.99" in back.text
    assert client.delete("/api/reports/changes/dismissals").status_code == 204
    assert db.query(ChangeDismissal).count() == 0


def test_prune_drops_old_dismissals(db: Session) -> None:
    now = datetime(2026, 10, 20, tzinfo=UTC)
    db.add_all(
        [
            ChangeDismissal(
                key="S3:entry:1:2026-06-01", signal="S3", dismissed_at=now - timedelta(days=91)
            ),
            ChangeDismissal(
                key="S3:entry:2:2026-10-01", signal="S3", dismissed_at=now - timedelta(days=5)
            ),
        ]
    )
    db.flush()
    assert changes.prune_dismissals(db, now) == 1
    assert [d.key for d in db.query(ChangeDismissal)] == ["S3:entry:2:2026-10-01"]


def test_order_by_priority_then_impact_and_cap(client: TestClient, db: Session) -> None:
    for i, amount in enumerate(
        [
            "-100.00",
            "-900.00",
            "-500.00",
            "-50.00",
            "-60.00",
            "-70.00",
            "-80.00",
            "-90.00",
            "-95.00",
        ]
    ):
        entry(db, amount, date(2026, 10, 1), description=f"Bill {i}")
    body = client.get("/api/reports/changes").json()
    s3 = [i for i in body["items"] if i["signal"] == "S3"]
    assert [i["amount"] for i in s3[:3]] == ["900.00", "500.00", "100.00"]
    assert len(body["items"]) == 7
    assert body["hidden"] == len(changes.compute(db, TODAY, include_all=True).items) - 7
    full = client.get("/api/reports/changes", params={"all": True}).json()
    assert full["hidden"] == 0


def test_fixture_list_is_deterministic(db: Session) -> None:
    load_simplefin_fixture(db)
    first = changes.compute(db, TODAY, include_all=True)
    second = changes.compute(db, TODAY, include_all=True)
    assert first == second
    assert all(len(i.text) < 120 for i in first.items)
    assert all(i.href.startswith("/") for i in first.items)


def test_never_calls_an_llm(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.providers.llm as llm

    def refuse(*args: object, **kwargs: object) -> None:
        raise AssertionError("What changed must not call an LLM provider")

    monkeypatch.setattr(llm, "get_llm_provider", refuse)
    load_simplefin_fixture(db)
    changes.compute(db, TODAY, include_all=True)
    source = __import__("inspect").getsource(changes)
    assert "providers.llm" not in source


def test_s4_bill_paid_early_each_month_is_not_above_pace(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression from real data: a loan paid on the 1st looked 675% above a prorated pace."""
    monkeypatch.setattr(schedule, "today", lambda: date(2026, 10, 4))
    acct = make_account(db)
    for month in (7, 8, 9, 10):
        tx = make_tx(
            db, acct, "-3000.00", "LOAN", date(2026, month, 1), merchant_key="CREDIT UNION LOAN"
        )
        categorize(db, tx.id, "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT", Essentiality.ESSENTIAL)
    confident(db)
    result = changes.compute(db, date(2026, 10, 4), include_all=True)
    assert [i for i in result.items if i.signal == "S4"] == []


def test_s6_regular_large_charge_is_not_unusual(db: Session) -> None:
    acct = make_account(db)
    small_expenses(db, acct)
    for month in (8, 9, 10):
        make_tx(
            db, acct, "-3000.00", "LOAN", date(2026, month, 1), merchant_key="CREDIT UNION LOAN"
        )
    assert items(db, "S6") == []
