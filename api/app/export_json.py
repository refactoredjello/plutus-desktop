"""Dump every table to one JSON file for the desktop import: `python -m app.export_json <path>`.

The desktop app reads the file with `server/scripts/import-json.ts` (docs/MIGRATING_DATA.md).
Encrypted settings are decrypted with the current SECRET_KEY, so the file holds the SimpleFIN
access URL in clear text. It is written owner-only and never overwrites a file; delete it after
the import.

Values: money is a two-decimal string, dates are YYYY-MM-DD, timestamps ISO 8601 in UTC,
booleans and ids as they are. Rows are ordered by primary key; tables in foreign-key order.
`sequences` holds, per table with an integer id, the highest id Postgres ever handed out.
"""

import json
import os
import sys
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

from sqlalchemy import Table, select, text
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db import get_sessionmaker
from app.models import (
    Account,
    AppSetting,
    BalanceSnapshot,
    Base,
    Categorization,
    Category,
    ChangeDismissal,
    Goal,
    ManualEntry,
    MerchantClassification,
    RecurringCharge,
    Rule,
    Suggestion,
    SyncRun,
    Transaction,
)
from app.services.app_settings import get_setting

FORMAT = "plutus-export"
FORMAT_VERSION = 1

# Parents before children, so an importer can insert in this order. transactions also refers
# to itself (transfer_pair_id); the importer fills that in a second pass.
_MODELS = (
    Account,
    BalanceSnapshot,
    Category,
    MerchantClassification,
    Rule,
    Goal,
    SyncRun,
    AppSetting,
    ChangeDismissal,
    Transaction,
    Categorization,
    ManualEntry,
    RecurringCharge,
    Suggestion,
)
_TABLES: tuple[Table, ...] = tuple(Base.metadata.tables[m.__tablename__] for m in _MODELS)
TABLES: tuple[str, ...] = tuple(t.name for t in _TABLES)

type Value = str | int | bool | None


def _value(value: object) -> Value:
    if isinstance(value, Decimal):
        return f"{value:.2f}"
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if value is None or isinstance(value, str | int | bool):
        return value
    raise TypeError(f"cannot export {type(value).__name__}")


def _rows(db: Session, settings: Settings, table: Table) -> list[dict[str, Value]]:
    rows = []
    for record in db.execute(select(table).order_by(*table.primary_key.columns)).mappings():
        row = {column.name: _value(record[column]) for column in table.columns}
        if table.name == AppSetting.__tablename__ and row["is_encrypted"]:
            # Raises DomainError when SECRET_KEY has changed: never export ciphertext.
            row["value"] = get_setting(db, settings, str(row["key"]))
        rows.append(row)
    return rows


_SEQUENCE = text(
    "SELECT coalesce(s.last_value, 0) FROM pg_sequences s"
    " WHERE format('%I.%I', s.schemaname, s.sequencename) = pg_get_serial_sequence(:t, 'id')"
)


def _sequence(db: Session, table: Table) -> int:
    """The highest id the table's sequence ever handed out, deleted rows included; 0 if none."""
    return int(db.execute(_SEQUENCE, {"t": table.name}).scalar_one())


def export_data(db: Session, settings: Settings) -> dict[str, object]:
    revision = db.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
    return {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "alembic_revision": revision,
        "exported_at": datetime.now(UTC).isoformat(),
        # Ids are never reused (change dismissal keys embed them); the importer keeps it so.
        "sequences": {t.name: _sequence(db, t) for t in _TABLES if "id" in t.columns},
        "tables": {table.name: _rows(db, settings, table) for table in _TABLES},
    }


def write_export(db: Session, settings: Settings, path: Path) -> dict[str, int]:
    """Write the export to a new owner-only file; returns the row count per table."""
    data = export_data(db, settings)
    body = json.dumps(data, indent=1, ensure_ascii=True) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(body)
    tables = data["tables"]
    assert isinstance(tables, dict)
    return {name: len(rows) for name, rows in tables.items()}


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: python -m app.export_json <path>", file=sys.stderr)
        return 2
    path = Path(argv[0])
    with get_sessionmaker()() as db:
        counts = write_export(db, get_settings(), path)
    for name, count in counts.items():
        print(f"{name:26} {count:7}")
    print(f"wrote {path}: it holds secrets in clear text; delete it after the import")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
