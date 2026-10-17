"""SimpleFIN Bridge adapter. Protocol: https://www.simplefin.org/protocol.html

Budget: 24 requests/day. The docs allow 90 days per request, but the live bridge warns above
45 days and says it may cap there, so `fetch` issues one request per 45-day chunk and never
retries. The access URL embeds credentials and must never be logged.
"""

import base64
import binascii
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from app.errors import ProviderError
from app.models.base import AccountType
from app.providers.bank.base import (
    ProviderAccount,
    ProviderSnapshot,
    ProviderTransaction,
)

PROVIDER_NAME = "simplefin"
MAX_WINDOW_DAYS = 45
TIMEOUT_SECONDS = 30.0


def new_client() -> httpx.Client:
    """Build the HTTP client used for real SimpleFIN calls. Tests patch this seam."""
    return httpx.Client(timeout=TIMEOUT_SECONDS)


def claim_setup_token(token: str, client: httpx.Client) -> str:
    """Exchange a one-time setup token for an access URL (a claim works only once)."""
    try:
        padded = token.strip() + "=" * (-len(token.strip()) % 4)
        claim_url = base64.b64decode(padded, altchars=b"-_").decode().strip()
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise ProviderError("The SimpleFIN setup token is not valid base64.") from exc
    if urlsplit(claim_url).scheme not in ("http", "https"):
        raise ProviderError("The SimpleFIN setup token does not contain a claim URL.")
    try:
        response = client.post(claim_url)
    except httpx.HTTPError as exc:
        raise ProviderError("Could not reach SimpleFIN to claim the setup token.") from exc
    if response.status_code != 200:
        raise ProviderError(
            f"SimpleFIN rejected the setup token (HTTP {response.status_code}). "
            "A token can be claimed only once; create a new one."
        )
    access_url = response.text.strip()
    if urlsplit(access_url).scheme not in ("http", "https"):
        raise ProviderError("SimpleFIN returned an unexpected access URL.")
    return access_url


def infer_account_type(name: str) -> AccountType:
    """SimpleFIN does not report account type, so guess from the account name."""
    lowered = name.lower()
    if any(w in lowered for w in ("card", "visa", "mastercard", "amex", "credit")):
        return AccountType.CREDIT
    if "saving" in lowered:
        return AccountType.SAVINGS
    if "checking" in lowered:
        return AccountType.CHECKING
    return AccountType.OTHER


def _ts(value: Any) -> datetime | None:
    seconds = int(value or 0)
    return datetime.fromtimestamp(seconds, UTC) if seconds > 0 else None


def _decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except InvalidOperation as exc:
        raise ProviderError(f"SimpleFIN returned a non-numeric amount: {value!r}") from exc


def chunk_ranges(start: date, end: date) -> list[tuple[date, date]]:
    """Inclusive, non-overlapping day ranges of at most MAX_WINDOW_DAYS days."""
    out: list[tuple[date, date]] = []
    cursor = start
    while cursor <= end:
        chunk_end = min(cursor + timedelta(days=MAX_WINDOW_DAYS - 1), end)
        out.append((cursor, chunk_end))
        cursor = chunk_end + timedelta(days=1)
    return out


def _midnight_unix(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=UTC).timestamp())


class SimpleFINProvider:
    name = PROVIDER_NAME

    def __init__(self, access_url: str, client: httpx.Client | None = None) -> None:
        parts = urlsplit(access_url)
        host = parts.hostname or ""
        netloc = f"{host}:{parts.port}" if parts.port else host
        self._base_url = urlunsplit((parts.scheme, netloc, parts.path.rstrip("/"), "", ""))
        self._auth = httpx.BasicAuth(parts.username or "", parts.password or "")
        self._client = client or new_client()
        self.requests_made = 0  # read by the sync service for the daily budget

    def fetch(self, start: date, end: date) -> ProviderSnapshot:
        accounts: dict[str, ProviderAccount] = {}
        errors: list[str] = []
        for chunk_start, chunk_end in chunk_ranges(start, end):
            payload = self._request(chunk_start, chunk_end)
            for err in payload.get("errors") or []:
                text = str(err)
                if text not in errors:
                    errors.append(text)
            for raw in payload.get("accounts") or []:
                parsed = self._parse_account(raw, chunk_end)
                existing = accounts.get(parsed.external_id)
                accounts[parsed.external_id] = (
                    parsed if existing is None else self._merge(existing, parsed)
                )
        return ProviderSnapshot(accounts=list(accounts.values()), errors=errors)

    def _request(self, start: date, end: date) -> dict[str, Any]:
        params = {
            "start-date": _midnight_unix(start),
            "end-date": _midnight_unix(end + timedelta(days=1)),
            "pending": 1,
        }
        self.requests_made += 1
        try:
            response = self._client.get(
                f"{self._base_url}/accounts", params=params, auth=self._auth
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"Could not reach SimpleFIN: {type(exc).__name__}") from exc
        if response.status_code != 200:
            raise ProviderError(f"SimpleFIN returned HTTP {response.status_code}.")
        try:
            data = response.json()
        except ValueError as exc:
            raise ProviderError("SimpleFIN returned a response that is not JSON.") from exc
        if not isinstance(data, dict):
            raise ProviderError("SimpleFIN returned an unexpected response shape.")
        return data

    @staticmethod
    def _parse_account(raw: dict[str, Any], window_end: date) -> ProviderAccount:
        org = raw.get("org") or {}
        available = raw.get("available-balance")
        transactions = [_parse_transaction(t, window_end) for t in raw.get("transactions") or []]
        return ProviderAccount(
            external_id=str(raw["id"]),
            name=str(raw.get("name") or raw["id"]),
            type=infer_account_type(str(raw.get("name") or "")),
            institution_name=org.get("name") or org.get("domain"),
            currency=str(raw.get("currency") or "USD")[:3].upper(),
            balance=_decimal(raw.get("balance", "0")),
            available=_decimal(available) if available not in (None, "") else None,
            balance_as_of=_ts(raw.get("balance-date")) or datetime.now(UTC),
            transactions=transactions,
        )

    @staticmethod
    def _merge(first: ProviderAccount, later: ProviderAccount) -> ProviderAccount:
        """Combine the same account from two chunks: newest balance, deduplicated transactions."""
        seen = {t.external_id: t for t in first.transactions}
        for t in later.transactions:
            seen[t.external_id] = t
        newest = later if later.balance_as_of >= first.balance_as_of else first
        return ProviderAccount(
            external_id=newest.external_id,
            name=newest.name,
            type=newest.type,
            institution_name=newest.institution_name,
            currency=newest.currency,
            balance=newest.balance,
            available=newest.available,
            balance_as_of=newest.balance_as_of,
            transactions=list(seen.values()),
        )


def _parse_transaction(raw: dict[str, Any], window_end: date) -> ProviderTransaction:
    posted = _ts(raw.get("posted"))
    transacted_at = _ts(raw.get("transacted_at"))
    pending = bool(raw.get("pending")) or posted is None
    if posted is not None:
        posted_on = posted.date()
    else:  # pending: no posting date yet, use when it happened, else the window end
        posted_on = transacted_at.date() if transacted_at else window_end
    return ProviderTransaction(
        external_id=str(raw["id"]),
        posted_on=posted_on,
        amount=_decimal(raw.get("amount", "0")),
        description=str(raw.get("description") or ""),
        payee=raw.get("payee") or None,
        memo=raw.get("memo") or None,
        pending=pending,
        transacted_at=transacted_at,
    )
