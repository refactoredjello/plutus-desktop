from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import BalanceSnapshot, Categorization, Category
from app.models.base import AccountType, ClassificationSource, Essentiality
from app.services.aggregates import (
    category_totals,
    current_total_balance,
    month_range,
    monthly_totals,
)
from tests.factories import make_account, make_tx


def categorize(db: Session, tx_id: int, detailed: str, ess: Essentiality | None = None) -> None:
    cat = db.scalar(select(Category).where(Category.detailed == detailed))
    assert cat is not None
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


def test_month_range_crosses_year_boundary() -> None:
    assert month_range(date(2026, 2, 15), 4) == ["2025-11", "2025-12", "2026-01", "2026-02"]


def test_monthly_totals_definitions(db: Session) -> None:
    chk = make_account(db, AccountType.CHECKING)
    sav = make_account(db, AccountType.SAVINGS)
    d = date(2026, 3, 10)
    salary = make_tx(db, chk, "3000.00", "ACME PAYROLL", d)
    categorize(db, salary.id, "INCOME_SALARY")
    coffee = make_tx(db, chk, "-5.50", "COFFEE", d)
    categorize(db, coffee.id, "FOOD_AND_DRINK_COFFEE", Essentiality.DISCRETIONARY)
    rent = make_tx(db, chk, "-2000.00", "RENT", d)
    categorize(db, rent.id, "RENT_AND_UTILITIES_RENT", Essentiality.ESSENTIAL)
    refund = make_tx(db, chk, "20.00", "STORE REFUND", d)
    categorize(
        db, refund.id, "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE", Essentiality.FLEXIBLE
    )
    make_tx(db, chk, "-30.00", "MYSTERY CHARGE", d)  # uncategorized expense
    make_tx(db, chk, "15.00", "MYSTERY DEPOSIT", d)  # uncategorized money in counts as income
    make_tx(db, chk, "-500.00", "TO SAVINGS", d, is_transfer=True)
    make_tx(db, sav, "500.00", "FROM CHECKING", d, is_transfer=True)

    feb, mar = monthly_totals(db, ["2026-02", "2026-03"])
    assert feb.income == feb.expenses == Decimal("0.00")
    assert mar.income == Decimal("3015.00")
    assert mar.expenses == Decimal("2015.50")  # 5.50 + 2000 - 20 refund + 30
    assert mar.essential == Decimal("2000.00")
    assert mar.discretionary == Decimal("5.50")
    assert mar.flexible == Decimal("-20.00")  # a refund-only month can go negative
    assert mar.uncategorized == Decimal("30.00")
    assert mar.net == Decimal("999.50")


def test_category_totals(db: Session) -> None:
    chk = make_account(db)
    for day, amount in [(date(2026, 3, 1), "-4.00"), (date(2026, 4, 2), "-6.00")]:
        tx = make_tx(db, chk, amount, "COFFEE", day)
        categorize(db, tx.id, "FOOD_AND_DRINK_COFFEE")
    rent = make_tx(db, chk, "-1000.00", "RENT", date(2026, 4, 1))
    categorize(db, rent.id, "RENT_AND_UTILITIES_RENT")
    make_tx(db, chk, "-7.00", "MYSTERY", date(2026, 4, 3))
    pay = make_tx(db, chk, "100.00", "PAY", date(2026, 4, 3))
    categorize(db, pay.id, "INCOME_SALARY")

    rows = category_totals(db, ["2026-03", "2026-04"])
    assert [r.label for r in rows] == ["Rent", "Coffee", "Uncategorized"]
    coffee = rows[1]
    assert coffee.total == Decimal("10.00")
    assert coffee.count == 2
    assert coffee.monthly == {"2026-03": Decimal("4.00"), "2026-04": Decimal("6.00")}
    assert rows[2].category_id is None


def test_current_total_balance_uses_latest_snapshot_of_active_accounts(db: Session) -> None:
    chk = make_account(db, AccountType.CHECKING)
    cc = make_account(db, AccountType.CREDIT)
    closed = make_account(db, AccountType.SAVINGS)
    closed.is_active = False
    t0, t1 = datetime(2026, 9, 1, tzinfo=UTC), datetime(2026, 9, 2, tzinfo=UTC)
    db.add_all(
        [
            BalanceSnapshot(account_id=chk.id, balance=Decimal("100.00"), as_of=t0),
            BalanceSnapshot(account_id=chk.id, balance=Decimal("250.00"), as_of=t1),
            BalanceSnapshot(account_id=cc.id, balance=Decimal("-40.00"), as_of=t1),
            BalanceSnapshot(account_id=closed.id, balance=Decimal("999.00"), as_of=t1),
        ]
    )
    db.flush()
    assert current_total_balance(db) == Decimal("210.00")


def test_category_totals_filtered_by_essentiality(db: Session) -> None:
    from app.models.base import EssentialityFilter

    chk = make_account(db)
    d = date(2026, 5, 3)
    rent = make_tx(db, chk, "-1000.00", "RENT", d)
    categorize(db, rent.id, "RENT_AND_UTILITIES_RENT", Essentiality.ESSENTIAL)
    coffee = make_tx(db, chk, "-6.00", "COFFEE", d)
    categorize(db, coffee.id, "FOOD_AND_DRINK_COFFEE", Essentiality.DISCRETIONARY)
    gift = make_tx(db, chk, "-40.00", "GIFT", d)
    categorize(db, gift.id, "GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES")  # no essentiality
    make_tx(db, chk, "-9.00", "MYSTERY", d)  # uncategorized

    def labels(f: EssentialityFilter) -> list[str]:
        return [r.label for r in category_totals(db, ["2026-05"], f)]

    assert labels(EssentialityFilter.ESSENTIAL) == ["Rent"]
    assert labels(EssentialityFilter.DISCRETIONARY) == ["Coffee"]
    assert labels(EssentialityFilter.UNSET) == ["Gifts and novelties", "Uncategorized"]


def test_money_movement_excluded_and_deposits_are_income(db: Session) -> None:
    chk = make_account(db, AccountType.CHECKING)
    d = date(2026, 6, 10)
    card_payment = make_tx(db, chk, "-900.00", "PAYMENT TO CARD", d)  # card not linked/paired
    categorize(db, card_payment.id, "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", Essentiality.ESSENTIAL)
    to_savings = make_tx(db, chk, "-500.00", "TO SAVINGS", d)
    categorize(db, to_savings.id, "TRANSFER_OUT_SAVINGS")
    deposit = make_tx(db, chk, "300.00", "ATM DEPOSIT", d)
    categorize(db, deposit.id, "TRANSFER_IN_DEPOSIT")
    venmo = make_tx(db, chk, "-60.00", "VENMO", d)  # P2P stays real spending
    categorize(db, venmo.id, "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS", Essentiality.DISCRETIONARY)
    loan = make_tx(db, chk, "-250.00", "LOAN", d)  # debt service stays counted
    categorize(db, loan.id, "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT", Essentiality.ESSENTIAL)

    (june,) = monthly_totals(db, ["2026-06"])
    assert june.income == Decimal("300.00")
    assert june.expenses == Decimal("310.00")  # 60 + 250
    assert june.essential == Decimal("250.00")
    labels = [r.label for r in category_totals(db, ["2026-06"])]
    assert "Credit card payment" not in labels
    assert "Savings" not in labels
