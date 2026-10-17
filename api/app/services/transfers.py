"""Internal transfer matching (R2.4). Owned by the Wave 1 categorization brief.

Called by services/sync.py after new transactions are stored. Keep the signature stable.
"""

from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Transaction

WINDOW = timedelta(days=5)  # card payments often post a few business days apart


def match_transfers(db: Session) -> int:
    """Pair unmatched transactions that are transfers between owned accounts.

    Two posted transactions pair when they sit in different accounts, have equal absolute
    amounts with opposite signs, and are at most 5 days apart. When several candidates
    exist the closest date wins, then the lowest ids, so results are deterministic.
    Returns the number of transactions newly marked as transfers. Does not commit.
    """
    unmatched = db.scalars(
        select(Transaction)
        .where(
            Transaction.is_transfer.is_(False),
            Transaction.transfer_pair_id.is_(None),
            Transaction.pending.is_(False),
            Transaction.amount != 0,
        )
        .order_by(Transaction.id)
    ).all()

    outflows: dict[Decimal, list[Transaction]] = defaultdict(list)
    inflows: dict[Decimal, list[Transaction]] = defaultdict(list)
    for tx in unmatched:
        (outflows if tx.amount < 0 else inflows)[abs(tx.amount)].append(tx)

    candidates: list[tuple[int, int, int, Transaction, Transaction]] = []
    for size, outs in outflows.items():
        for out in outs:
            for inc in inflows.get(size, []):
                gap = abs(out.posted_on - inc.posted_on)
                if out.account_id != inc.account_id and gap <= WINDOW:
                    candidates.append(
                        (gap.days, min(out.id, inc.id), max(out.id, inc.id), out, inc)
                    )
    candidates.sort(key=lambda c: c[:3])

    used: set[int] = set()
    marked = 0
    for _, _, _, out, inc in candidates:
        if out.id in used or inc.id in used:
            continue
        used.update((out.id, inc.id))
        out.is_transfer = inc.is_transfer = True
        out.transfer_pair_id = inc.id
        inc.transfer_pair_id = out.id
        marked += 2
    if marked:
        db.flush()
    return marked
