"""Seed categories from Plaid's Personal Finance Categories v2.

Revision ID: 0002
Revises: 0001
"""

import csv
from collections.abc import Sequence
from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SEED = Path(__file__).parents[2] / "app" / "seed" / "plaid_pfc_v2.csv"
ACRONYMS = {"Tv": "TV", "Atm": "ATM"}


def label_for(primary: str, detailed: str) -> str:
    """FOOD_AND_DRINK_COFFEE -> 'Coffee'; ENTERTAINMENT_TV_AND_MOVIES -> 'TV and movies'."""
    words = detailed.removeprefix(primary + "_").lower().split("_")
    words[0] = words[0].capitalize()
    return " ".join(ACRONYMS.get(w.capitalize(), w) for w in words)


def upgrade() -> None:
    categories = sa.table(
        "categories",
        sa.column("primary", sa.String),
        sa.column("detailed", sa.String),
        sa.column("label", sa.String),
        sa.column("description", sa.Text),
        sa.column("is_hidden", sa.Boolean),
        sa.column("is_custom", sa.Boolean),
    )
    with SEED.open(encoding="utf-8") as f:
        rows = [
            {
                "primary": r["primary"],
                "detailed": r["detailed"],
                "label": label_for(r["primary"], r["detailed"]),
                "description": r["description"] or None,
                "is_hidden": False,
                "is_custom": False,
            }
            for r in csv.DictReader(f)
        ]
    op.bulk_insert(categories, rows)


def downgrade() -> None:
    op.execute("DELETE FROM categories WHERE is_custom = false")
