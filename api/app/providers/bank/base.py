"""Bank data provider interface. Nothing provider-specific may leak past these types."""

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Protocol

from app.models.base import AccountType


@dataclass(frozen=True)
class ProviderTransaction:
    external_id: str
    posted_on: date
    amount: Decimal  # negative = outflow
    description: str
    payee: str | None = None
    memo: str | None = None
    pending: bool = False
    transacted_at: datetime | None = None


@dataclass(frozen=True)
class ProviderAccount:
    external_id: str
    name: str
    type: AccountType
    institution_name: str | None
    currency: str
    balance: Decimal
    available: Decimal | None
    balance_as_of: datetime
    transactions: list[ProviderTransaction] = field(default_factory=list)


@dataclass(frozen=True)
class ProviderSnapshot:
    accounts: list[ProviderAccount]
    errors: list[str] = field(default_factory=list)


class BankProvider(Protocol):
    """Implementations may expose `requests_made: int` so syncs can track a request budget."""

    name: str

    def fetch(self, start: date, end: date) -> ProviderSnapshot:
        """Return all accounts with transactions posted between start and end, inclusive."""
        ...
