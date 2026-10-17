"""The JSON export the desktop importer reads (docs/DESKTOP_PLAN.md brief 2D)."""

import json
import os
import stat
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from pydantic import SecretStr
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.errors import DomainError
from app.export_json import FORMAT, FORMAT_VERSION, TABLES, export_data, write_export
from app.models import (
    AppSetting,
    BalanceSnapshot,
    Base,
    Categorization,
    Category,
    Goal,
)
from app.models.base import ClassificationSource
from app.services.app_settings import SIMPLEFIN_ACCESS_URL, set_setting
from tests.factories import make_account, make_tx

API_DIR = Path(__file__).parents[1]
FAKE_ACCESS_URL = "https://demo-user:demo-pass@bridge.invalid/simplefin"


def _settings(key: str = "export-test-key") -> Settings:
    return Settings(secret_key=SecretStr(key))


def _head_revision() -> str:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(API_DIR / "alembic"))
    head = ScriptDirectory.from_config(cfg).get_current_head()
    assert head is not None
    return head


def _rows(data: dict[str, object], table: str) -> list[dict[str, object]]:
    tables = data["tables"]
    assert isinstance(tables, dict)
    rows = tables[table]
    assert isinstance(rows, list)
    return rows


def test_envelope_names_format_version_and_alembic_revision(db: Session) -> None:
    data = export_data(db, _settings())

    assert data["format"] == FORMAT == "plutus-export"
    assert data["format_version"] == FORMAT_VERSION == 2
    assert data["alembic_revision"] == _head_revision()
    exported_at = datetime.fromisoformat(str(data["exported_at"]))
    assert exported_at.utcoffset() == timedelta(0)


def test_every_table_in_foreign_key_order(db: Session) -> None:
    data = export_data(db, _settings())
    tables = data["tables"]
    assert isinstance(tables, dict)

    assert list(tables) == list(TABLES)
    assert set(TABLES) == set(Base.metadata.tables)
    assert len(TABLES) == 14
    # A table comes after every table it references (the transactions self-reference aside).
    order = {name: i for i, name in enumerate(TABLES)}
    for table in Base.metadata.sorted_tables:
        for fk in table.foreign_keys:
            parent = fk.column.table.name
            if parent != table.name:
                assert order[parent] < order[table.name], (parent, table.name)


def test_rows_carry_every_column_and_match_row_counts(db: Session) -> None:
    account = make_account(db)
    make_tx(db, account, "-1.00")
    make_tx(db, account, "-2.00")
    data = export_data(db, _settings())

    for name, table in Base.metadata.tables.items():
        rows = _rows(data, name)
        assert len(rows) == db.scalar(select(func.count()).select_from(table))
        for row in rows:
            assert list(row) == [c.name for c in table.columns]


def test_categories_keep_seed_and_custom_rows_with_ids(db: Session) -> None:
    seeded = db.scalar(select(func.count()).select_from(Category))
    custom = Category(
        primary="CUSTOM", detailed="CUSTOM_PETS", label="Pets", is_custom=True, is_hidden=False
    )
    db.add(custom)
    db.flush()

    rows = _rows(export_data(db, _settings()), "categories")

    assert len(rows) == (seeded or 0) + 1
    ids = [int(str(r["id"])) for r in rows]
    assert ids == sorted(ids)
    assert rows[-1] == {
        "id": custom.id,
        "primary": "CUSTOM",
        "detailed": "CUSTOM_PETS",
        "label": "Pets",
        "description": None,
        "is_hidden": False,
        "is_custom": True,
    }


def test_money_is_a_two_decimal_string(db: Session) -> None:
    account = make_account(db)
    tx = make_tx(db, account, "-15.4")
    db.add(
        BalanceSnapshot(
            account_id=account.id,
            balance=Decimal("1200"),
            available=None,
            as_of=datetime(2026, 1, 2, tzinfo=UTC),
        )
    )
    db.add(
        Goal(
            name="Trip",
            target_amount=Decimal("3000.5"),
            target_date=date(2027, 1, 1),
            starting_amount=Decimal("-0.01"),
        )
    )
    db.flush()

    data = export_data(db, _settings())

    [row] = [r for r in _rows(data, "transactions") if r["id"] == tx.id]
    assert row["amount"] == "-15.40"
    [snap] = _rows(data, "balance_snapshots")
    assert snap["balance"] == "1200.00"
    assert snap["available"] is None
    [goal] = _rows(data, "goals")
    assert goal["target_amount"] == "3000.50"
    assert goal["starting_amount"] == "-0.01"


def test_dates_and_timestamps_are_iso_and_timestamps_utc(db: Session) -> None:
    account = make_account(db)
    plus_two = timezone(timedelta(hours=2))
    tx = make_tx(
        db,
        account,
        "-1.00",
        posted_on=date(2026, 3, 4),
        transacted_at=datetime(2026, 3, 4, 1, 2, 3, 456789, tzinfo=plus_two),
    )
    db.add(
        BalanceSnapshot(
            account_id=account.id,
            balance=Decimal("1"),
            as_of=datetime(2026, 3, 5, 6, 7, 8, tzinfo=UTC),
        )
    )
    db.flush()

    data = export_data(db, _settings())

    [row] = [r for r in _rows(data, "transactions") if r["id"] == tx.id]
    assert row["posted_on"] == "2026-03-04"
    assert row["transacted_at"] == "2026-03-03T23:02:03.456789+00:00"
    for column in ("created_at", "updated_at"):
        stamp = datetime.fromisoformat(str(row[column]))
        assert stamp.utcoffset() == timedelta(0)
    [snap] = _rows(data, "balance_snapshots")
    assert snap["as_of"] == "2026-03-05T06:07:08+00:00"


def test_booleans_ids_and_the_transfer_pair_survive(db: Session) -> None:
    a = make_account(db, name="Checking")
    b = make_account(db, name="Savings")
    out = make_tx(db, a, "-100.00", is_transfer=True, pending=True)
    back = make_tx(db, b, "100.00", is_transfer=True, transfer_pair_id=out.id, one_time=True)
    out.transfer_pair_id = back.id
    db.flush()

    rows = {r["id"]: r for r in _rows(export_data(db, _settings()), "transactions")}

    assert rows[out.id]["transfer_pair_id"] == back.id
    assert rows[back.id]["transfer_pair_id"] == out.id
    assert rows[out.id]["is_transfer"] is True
    assert rows[out.id]["pending"] is True
    assert rows[out.id]["one_time"] is False
    assert rows[back.id]["one_time"] is True
    assert rows[back.id]["account_id"] == b.id


def test_rows_are_ordered_by_primary_key(db: Session) -> None:
    account = make_account(db)
    txs = [make_tx(db, account, "-1.00", posted_on=date(2026, 1, d)) for d in (9, 3, 6)]
    cat = db.scalars(select(Category).limit(1)).one()
    for tx in reversed(txs):
        db.add(
            Categorization(
                transaction_id=tx.id,
                category_id=cat.id,
                source=ClassificationSource.MANUAL,
                updated_at=datetime.now(UTC),
            )
        )
    db.flush()

    data = export_data(db, _settings())

    assert [r["id"] for r in _rows(data, "transactions")] == [t.id for t in txs]
    assert [r["transaction_id"] for r in _rows(data, "categorizations")] == [t.id for t in txs]


def test_encrypted_settings_are_decrypted_into_the_clear(db: Session) -> None:
    settings = _settings()
    set_setting(db, settings, SIMPLEFIN_ACCESS_URL, FAKE_ACCESS_URL, encrypt=True)
    set_setting(db, settings, "simplefin_connected_at", "2026-01-01T00:00:00+00:00")
    stored = db.get(AppSetting, SIMPLEFIN_ACCESS_URL)
    assert stored is not None
    assert stored.value != FAKE_ACCESS_URL

    rows = {r["key"]: r for r in _rows(export_data(db, settings), "app_settings")}

    assert rows[SIMPLEFIN_ACCESS_URL]["value"] == FAKE_ACCESS_URL
    assert rows[SIMPLEFIN_ACCESS_URL]["is_encrypted"] is True
    assert rows["simplefin_connected_at"]["value"] == "2026-01-01T00:00:00+00:00"
    assert rows["simplefin_connected_at"]["is_encrypted"] is False


def test_a_changed_secret_key_refuses_to_export(db: Session) -> None:
    set_setting(db, _settings("old-key"), SIMPLEFIN_ACCESS_URL, FAKE_ACCESS_URL, encrypt=True)

    with pytest.raises(DomainError, match="cannot be decrypted"):
        export_data(db, _settings("new-key"))


def test_write_export_is_owner_only_and_never_overwrites(db: Session, tmp_path: Path) -> None:
    out = tmp_path / "plutus-export.json"

    counts = write_export(db, _settings(), out)

    data = json.loads(out.read_text())
    assert data["format"] == "plutus-export"
    assert counts == {name: len(rows) for name, rows in data["tables"].items()}
    assert stat.S_IMODE(os.stat(out).st_mode) == 0o600
    with pytest.raises(FileExistsError):
        write_export(db, _settings(), out)


def test_sequences_record_the_highest_id_ever_handed_out(db: Session) -> None:
    account = make_account(db)
    kept = make_tx(db, account, "-1.00")
    dropped = make_tx(db, account, "-2.00")
    db.delete(dropped)
    db.flush()

    data = export_data(db, _settings())
    sequences = data["sequences"]
    assert isinstance(sequences, dict)

    with_id = [name for name in TABLES if "id" in Base.metadata.tables[name].columns]
    assert list(sequences) == with_id
    assert "categorizations" not in sequences
    assert max(int(str(r["id"])) for r in _rows(data, "transactions")) == kept.id
    # Ids are never reused: a deleted row's id stays taken, and the importer keeps it so.
    assert sequences["transactions"] >= dropped.id
    assert sequences["accounts"] >= account.id
    assert sequences["categories"] >= 1


def test_runtime_config_carries_the_env_settings_keyed_like_config_update(db: Session) -> None:
    settings = Settings(
        secret_key=SecretStr("export-test-key"),
        llm_provider="claude",  # type: ignore[arg-type]
        llm_model="claude-haiku-4-5",
        anthropic_api_key=SecretStr("sk-ant-fake-not-a-key"),
        ollama_base_url="http://localhost:11434",
        owner_name_tokens=["ALEX", "SAMPLE"],
        sync_interval_hours=12,
        sync_first_history_days=90,
        scheduler_enabled=False,
    )

    data = export_data(db, settings)

    assert data["runtime_config"] == {
        "llm_provider": "claude",
        "llm_model": "claude-haiku-4-5",
        "anthropic_api_key": "sk-ant-fake-not-a-key",
        "ollama_base_url": "http://localhost:11434",
        "owner_name_tokens": ["ALEX", "SAMPLE"],
        "sync_interval_hours": 12,
        "sync_first_history_days": 90,
        "scheduler_enabled": False,
    }
    assert list(data)[-1] == "tables"


@pytest.mark.parametrize("key", [None, "", "   "])
def test_a_missing_or_blank_api_key_exports_as_null(db: Session, key: str | None) -> None:
    settings = Settings(
        secret_key=SecretStr("export-test-key"),
        anthropic_api_key=None if key is None else SecretStr(key),
    )

    config = export_data(db, settings)["runtime_config"]

    assert isinstance(config, dict)
    assert config["anthropic_api_key"] is None
    assert config["llm_provider"] == settings.llm_provider.value
