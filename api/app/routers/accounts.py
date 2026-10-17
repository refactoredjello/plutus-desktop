"""Accounts with their latest balance snapshot."""

from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import distinct_on

from app.deps import DbSession
from app.models import Account, BalanceSnapshot
from app.schemas.accounts import AccountRead

router = APIRouter(prefix="/accounts", tags=["accounts"])


@router.get("", response_model=list[AccountRead])
def list_accounts(db: DbSession) -> list[AccountRead]:
    latest = {
        s.account_id: s
        for s in db.scalars(
            select(BalanceSnapshot)
            .ext(distinct_on(BalanceSnapshot.account_id))
            .order_by(
                BalanceSnapshot.account_id, BalanceSnapshot.as_of.desc(), BalanceSnapshot.id.desc()
            )
        )
    }
    out: list[AccountRead] = []
    for a in db.scalars(
        select(Account).order_by(Account.institution_name, Account.name, Account.id)
    ):
        snap = latest.get(a.id)
        out.append(
            AccountRead(
                id=a.id,
                name=a.name,
                type=a.type,
                institution_name=a.institution_name,
                currency=a.currency,
                is_active=a.is_active,
                balance=snap.balance if snap else None,
                available=snap.available if snap else None,
                balance_as_of=snap.as_of if snap else None,
            )
        )
    return out
