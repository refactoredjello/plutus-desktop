import base64
from datetime import date

import httpx
import pytest

from app.errors import ProviderError
from app.models.base import AccountType
from app.providers.bank.simplefin import (
    SimpleFINProvider,
    claim_setup_token,
    infer_account_type,
)
from tests.simplefin_helpers import ACCESS_URL, load_fixture, make_token, mock_client


def test_claim_exchanges_token_for_access_url() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=ACCESS_URL + "\n")

    url = claim_setup_token(make_token(), mock_client(handler, seen))
    assert url == ACCESS_URL
    assert seen[0].method == "POST"
    assert str(seen[0].url) == "https://bridge.example/simplefin/claim/abc"
    assert seen[0].content == b""


def test_claim_rejects_bad_token_and_failed_claim() -> None:
    with pytest.raises(ProviderError):
        claim_setup_token("!!!not base64!!!", mock_client())
    with pytest.raises(ProviderError):
        claim_setup_token(base64.b64encode(b"not a url").decode(), mock_client())
    denied = mock_client(lambda r: httpx.Response(403))
    with pytest.raises(ProviderError, match="403"):
        claim_setup_token(make_token(), denied)


def test_fetch_parses_fixture_including_pending() -> None:
    requests: list[httpx.Request] = []
    provider = SimpleFINProvider(ACCESS_URL, mock_client(requests=requests))
    snap = provider.fetch(date(2026, 9, 1), date(2026, 10, 3))
    assert len(requests) == 1
    req = requests[0]
    assert req.url.host == "bridge.example"
    assert req.url.path == "/simplefin/accounts"
    assert "user123" not in str(req.url)
    assert req.headers["authorization"].startswith("Basic ")
    assert req.url.params["pending"] == "1"
    assert "start-date" in req.url.params
    assert "end-date" in req.url.params

    by_name = {a.name: a for a in snap.accounts}
    assert set(by_name) == {"Everyday Checking", "Rewards Visa", "High Yield Savings"}
    assert by_name["Rewards Visa"].type is AccountType.CREDIT
    assert by_name["High Yield Savings"].type is AccountType.SAVINGS
    assert by_name["Everyday Checking"].type is AccountType.CHECKING
    assert by_name["Rewards Visa"].institution_name == "Example Card Co"
    assert str(by_name["Rewards Visa"].balance) == "-842.17"
    assert str(by_name["Rewards Visa"].available) == "7157.83"
    assert snap.errors == []
    pending = [t for a in snap.accounts for t in a.transactions if t.pending]
    assert [t.external_id for t in pending] == ["TRN-100294"]
    assert pending[0].posted_on == pending[0].transacted_at.date()
    first = by_name["Everyday Checking"].transactions[0]
    assert first.payee == "Acme Corp"
    assert first.memo is None  # empty string normalized


def test_fetch_chunks_long_windows_and_merges() -> None:
    requests: list[httpx.Request] = []
    provider = SimpleFINProvider(ACCESS_URL, mock_client(requests=requests))
    snap = provider.fetch(date(2026, 1, 1), date(2026, 7, 1))  # 182 days -> 5 chunks of <=45
    assert len(requests) == 5
    for r in requests:
        span = int(r.url.params["end-date"]) - int(r.url.params["start-date"])
        assert span <= 45 * 86400
    assert len(snap.accounts) == 3  # merged, not tripled
    assert sum(len(a.transactions) for a in snap.accounts) == 295  # deduplicated


def test_provider_errors_are_surfaced() -> None:
    payload = load_fixture()
    payload["errors"] = ["Connection to Example Bank may need attention"]
    snap = SimpleFINProvider(ACCESS_URL, mock_client(payload)).fetch(
        date(2026, 9, 1), date(2026, 10, 3)
    )
    assert snap.errors == ["Connection to Example Bank may need attention"]


def test_http_failure_raises_provider_error() -> None:
    provider = SimpleFINProvider(ACCESS_URL, mock_client(lambda r: httpx.Response(402)))
    with pytest.raises(ProviderError, match="402"):
        provider.fetch(date(2026, 9, 1), date(2026, 10, 3))


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Chase Sapphire Credit Card", AccountType.CREDIT),
        ("Amex Gold", AccountType.CREDIT),
        ("Online Savings", AccountType.SAVINGS),
        ("Total Checking", AccountType.CHECKING),
        ("Brokerage", AccountType.OTHER),
    ],
)
def test_infer_account_type(name: str, expected: AccountType) -> None:
    assert infer_account_type(name) is expected
