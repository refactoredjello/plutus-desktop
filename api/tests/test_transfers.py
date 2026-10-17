from datetime import date

from sqlalchemy.orm import Session

from app.models.base import AccountType
from app.services.transfers import match_transfers
from tests.factories import load_simplefin_fixture, make_account, make_tx


def test_fixture_card_payments_and_savings_transfers_pair(db: Session) -> None:
    txs = load_simplefin_fixture(db)
    marked = match_transfers(db)
    transfers = [t for t in txs if t.is_transfer]
    assert marked == len(transfers) > 0
    by_id = {t.id: t for t in txs}
    for t in transfers:
        other = by_id[t.transfer_pair_id]
        assert other.transfer_pair_id == t.id
        assert other.account_id != t.account_id
        assert other.amount == -t.amount
        assert abs((other.posted_on - t.posted_on).days) <= 3
    descriptions = {t.raw_description.split(" ")[0] for t in transfers}
    assert descriptions == {"PAYMENT", "ONLINE", "AUTOMATIC"}
    assert sum("CHASE CARD" in t.raw_description for t in transfers) == 6
    assert sum("SAV" in t.raw_description for t in transfers) == 6


def test_fixture_has_no_false_pairs(db: Session) -> None:
    txs = load_simplefin_fixture(db)
    match_transfers(db)
    legit = ("PAYMENT TO CHASE", "AUTOMATIC PAYMENT", "ONLINE TRANSFER")
    for t in txs:
        if t.is_transfer:
            assert t.raw_description.startswith(legit), t.raw_description
        else:
            assert not t.raw_description.startswith(legit[1:]), t.raw_description


def test_is_idempotent(db: Session) -> None:
    load_simplefin_fixture(db)
    assert match_transfers(db) > 0
    assert match_transfers(db) == 0


def test_same_account_never_pairs(db: Session) -> None:
    a = make_account(db)
    make_tx(db, a, "-50.00")
    make_tx(db, a, "50.00")
    assert match_transfers(db) == 0


def test_window_is_five_days(db: Session) -> None:
    a, b = make_account(db), make_account(db, AccountType.SAVINGS)
    out = make_tx(db, a, "-80.00", posted_on=date(2026, 1, 10))
    far = make_tx(db, b, "80.00", posted_on=date(2026, 1, 16))
    assert match_transfers(db) == 0
    near = make_tx(db, b, "80.00", posted_on=date(2026, 1, 15))
    assert match_transfers(db) == 2
    assert out.transfer_pair_id == near.id
    assert not far.is_transfer


def test_closest_date_then_lowest_id_wins(db: Session) -> None:
    a, b = make_account(db), make_account(db)
    out = make_tx(db, a, "-20.00", posted_on=date(2026, 2, 10))
    farther = make_tx(db, b, "20.00", posted_on=date(2026, 2, 12))
    first_close = make_tx(db, b, "20.00", posted_on=date(2026, 2, 11))
    second_close = make_tx(db, b, "20.00", posted_on=date(2026, 2, 11))
    match_transfers(db)
    assert out.transfer_pair_id == first_close.id
    assert not farther.is_transfer
    assert not second_close.is_transfer


def test_pending_and_zero_amounts_are_skipped(db: Session) -> None:
    a, b = make_account(db), make_account(db)
    make_tx(db, a, "-9.00", pending=True)
    make_tx(db, b, "9.00")
    make_tx(db, a, "0.00")
    make_tx(db, b, "0.00")
    assert match_transfers(db) == 0
