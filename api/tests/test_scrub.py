import json
import os
import re
from decimal import Decimal

import pytest

from app.models.base import AccountType
from app.services.scrub import amount_bucket, build_merchant_input, merchant_key
from tests.factories import FIXTURES, OWNER_TOKENS

with open(os.path.join(FIXTURES, "scrub_golden.json")) as _f:
    GOLDEN = json.load(_f)


def _assert_invariants(key: str) -> None:
    assert not re.search(r"\d{4,}", key), key
    assert not any(t in key.upper() for t in OWNER_TOKENS), key
    assert key == key.upper()
    assert key


@pytest.mark.parametrize("case", GOLDEN, ids=[c["raw"] for c in GOLDEN])
def test_golden(case: dict[str, object]) -> None:
    key = merchant_key(str(case["raw"]), OWNER_TOKENS)
    if case["expected_key"] is not None:
        assert key == case["expected_key"]
    for forbidden in case["must_not_contain"]:  # type: ignore[attr-defined]
        assert forbidden not in key
    _assert_invariants(key)


@pytest.mark.parametrize(
    "raw",
    [
        "card 4111 1111 1111 1111 purchase",
        "ALEXANDER SAMPLEVILLE ALEX'S DINER",
        "pp*Some Seller 8005551234",
        "PAYMENT 2026-03-04 TRACE # 99887766",
        "VENMO CASHOUT JANE DOE",
        "ZELLE PAYMENT FROM Alex Sample 12345",
        "STORE 12 CHARGE (415) 555-0100",
        "1234567",
    ],
)
def test_invariants_on_awkward_input(raw: str) -> None:
    _assert_invariants(merchant_key(raw, OWNER_TOKENS))


def test_whitespace_and_case_normalized() -> None:
    assert merchant_key("  trader   joe s  ", []) == "TRADER JOE S"


def test_same_merchant_same_key_across_store_numbers() -> None:
    a = merchant_key("TRADER JOE S #552 OAKLAND CA", [])
    b = merchant_key("TRADER JOE S #101 OAKLAND CA", [])
    assert a == b


@pytest.mark.parametrize(
    ("amount", "bucket"),
    [
        ("-3.50", "<10"),
        ("10.00", "10-50"),
        ("-49.99", "10-50"),
        ("50", "50-200"),
        ("-199.99", "50-200"),
        ("200", "200-1000"),
        ("-1000", "200-1000"),
        ("1000.01", ">1000"),
    ],
)
def test_amount_bucket(amount: str, bucket: str) -> None:
    assert amount_bucket(Decimal(amount)) == bucket


def test_build_merchant_input() -> None:
    item = build_merchant_input("NETFLIX.COM CA", Decimal("-15.49"), AccountType.CREDIT)
    assert (item.amount_bucket, item.direction, item.account_kind) == ("10-50", "outflow", "credit")
    assert build_merchant_input("X", Decimal("5"), AccountType.SAVINGS).direction == "inflow"
