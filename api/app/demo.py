"""Load or clear fake demo data for local development.

    python -m app.demo load    # sync the fake SimpleFIN fixture through the real pipeline
    python -m app.demo clear   # delete demo accounts, their transactions, and demo sync runs

Demo rows use provider "demo", so they never mix with a real SimpleFIN connection.
Run `clear` before connecting a real bank so demo classifications are not reused.
"""

import json
import sys
from pathlib import Path

import httpx
from sqlalchemy import delete, select

from app.config import get_settings
from app.db import get_sessionmaker
from app.models import Account, MerchantClassification, SyncRun, Transaction
from app.models.base import SyncTrigger
from app.providers.bank.simplefin import SimpleFINProvider
from app.services.sync import run_sync

DEMO_PROVIDER = "demo"
FIXTURE = Path(__file__).parents[1] / "tests" / "fixtures" / "simplefin_accounts.json"


def _demo_provider() -> SimpleFINProvider:
    payload = json.loads(FIXTURE.read_text())
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
    provider = SimpleFINProvider(
        "https://demo:demo@demo.invalid/simplefin", client=httpx.Client(transport=transport)
    )
    provider.name = DEMO_PROVIDER
    return provider


def load() -> None:
    with get_sessionmaker()() as db:
        run = run_sync(db, get_settings(), _demo_provider(), SyncTrigger.MANUAL)
        print(f"demo sync {run.status}: added {run.added}, updated {run.updated}")
        if run.error_text:
            print(run.error_text)


def clear() -> None:
    with get_sessionmaker()() as db:
        accounts = len(
            db.scalars(
                delete(Account).where(Account.provider == DEMO_PROVIDER).returning(Account.id)
            ).all()
        )
        db.execute(delete(SyncRun).where(SyncRun.provider == DEMO_PROVIDER))
        # Demo data is classified by whichever LLM is configured, often the fake one. Drop cached
        # classifications no remaining transaction uses, so real data gets classified fresh.
        orphans = len(
            db.scalars(
                delete(MerchantClassification)
                .where(
                    MerchantClassification.merchant_key.not_in(
                        select(Transaction.merchant_key).where(
                            Transaction.merchant_key.is_not(None)
                        )
                    )
                )
                .returning(MerchantClassification.merchant_key)
            ).all()
        )
        db.commit()
        print(
            f"removed {accounts} demo accounts, their transactions, and {orphans} cached merchants"
        )
        print("Rules you created are kept.")


if __name__ == "__main__":
    commands = {"load": load, "clear": clear}
    if len(sys.argv) != 2 or sys.argv[1] not in commands:
        sys.exit(__doc__)
    commands[sys.argv[1]]()
