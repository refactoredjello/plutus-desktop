from datetime import datetime

from app.models.base import AccountType
from app.schemas.common import Money, ReadSchema


class AccountRead(ReadSchema):
    id: int
    name: str
    type: AccountType
    institution_name: str | None
    currency: str
    is_active: bool
    balance: Money | None
    available: Money | None
    balance_as_of: datetime | None
