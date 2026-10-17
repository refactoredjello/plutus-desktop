"""Helpers that insert accounts and transactions directly, without the sync service."""

import json
import os
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Account, Category, Transaction
from app.models.base import AccountType

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
OWNER_TOKENS = ["ALEX", "SAMPLE"]

_TYPES = {"chk": AccountType.CHECKING, "cc": AccountType.CREDIT, "sav": AccountType.SAVINGS}
_counter = 0


def settings_with_owner() -> Settings:
    return Settings(owner_name_tokens=OWNER_TOKENS, llm_provider="fake")  # type: ignore[arg-type]


def make_account(
    db: Session, type_: AccountType = AccountType.CHECKING, name: str = "Acct"
) -> Account:
    global _counter
    _counter += 1
    account = Account(provider="test", external_id=f"A{_counter}", name=name, type=type_)
    db.add(account)
    db.flush()
    return account


def make_tx(
    db: Session,
    account: Account,
    amount: str,
    description: str = "SOME MERCHANT",
    posted_on: date = date(2026, 1, 10),
    **kwargs: object,
) -> Transaction:
    global _counter
    _counter += 1
    tx = Transaction(
        account_id=account.id,
        external_id=f"T{_counter}",
        posted_on=posted_on,
        amount=Decimal(amount),
        raw_description=description,
        **kwargs,
    )
    db.add(tx)
    db.flush()
    return tx


def load_simplefin_fixture(db: Session) -> list[Transaction]:
    with open(os.path.join(FIXTURES, "simplefin_accounts.json")) as f:
        data = json.load(f)
    txs: list[Transaction] = []
    for acct in data["accounts"]:
        account = make_account(db, _TYPES[acct["id"].split("-")[1]], acct["name"])
        for t in acct["transactions"]:
            stamp = t["posted"] or t["transacted_at"]
            txs.append(
                make_tx(
                    db,
                    account,
                    t["amount"],
                    t["description"],
                    datetime.fromtimestamp(stamp, UTC).date(),
                    payee=t["payee"] or None,
                    memo=t["memo"] or None,
                    pending=t["pending"],
                )
            )
    return txs


def category_id(db: Session, detailed: str) -> int:
    return db.scalars(select(Category.id).where(Category.detailed == detailed)).one()
