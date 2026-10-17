from contextlib import nullcontext

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.providers.bank import simplefin
from app.routers import sync as sync_router
from tests.simplefin_helpers import ACCESS_URL, make_token, mock_client


@pytest.fixture
def mocked_simplefin(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, text=ACCESS_URL)
        from tests.simplefin_helpers import load_fixture

        return httpx.Response(200, json=load_fixture())

    monkeypatch.setattr(simplefin, "new_client", lambda: mock_client(handler))
    # The background task opens its own session; point it at the test's transaction.
    monkeypatch.setattr(sync_router, "get_sessionmaker", lambda: lambda: nullcontext(db))


def connect(client: TestClient) -> None:
    r = client.post("/api/settings/simplefin", json={"setup_token": make_token()})
    assert r.status_code == 200, r.text


def test_simplefin_status_connect_disconnect(client: TestClient, mocked_simplefin: None) -> None:
    assert client.get("/api/settings/simplefin").json() == {
        "connected": False,
        "connected_at": None,
    }
    r = client.post("/api/settings/simplefin", json={"setup_token": make_token()})
    assert r.status_code == 200
    assert r.json()["connected"] is True
    assert "pass456" not in r.text
    status = client.get("/api/settings/simplefin").json()
    assert status["connected"] is True
    assert status["connected_at"]
    assert client.delete("/api/settings/simplefin").status_code == 204
    assert client.get("/api/settings/simplefin").json()["connected"] is False


def test_connect_with_bad_token_is_502(client: TestClient) -> None:
    r = client.post("/api/settings/simplefin", json={"setup_token": "%%%"})
    assert r.status_code == 502


def test_sync_requires_connection(client: TestClient) -> None:
    assert client.post("/api/sync").status_code == 400


def test_sync_happy_path_and_runs(client: TestClient, mocked_simplefin: None) -> None:
    connect(client)
    r = client.post("/api/sync")
    assert r.status_code == 202
    run_id = r.json()["id"]
    assert r.json()["trigger"] == "manual"

    done = client.get(f"/api/sync/runs/{run_id}").json()
    assert done["status"] == "success"
    assert done["added"] == 295

    runs = client.get("/api/sync/runs").json()
    assert [x["id"] for x in runs] == [run_id]

    accounts = client.get("/api/accounts").json()
    assert len(accounts) == 3
    visa = next(a for a in accounts if a["name"] == "Rewards Visa")
    assert visa["type"] == "credit"
    assert visa["balance"] == "-842.17"
    assert visa["available"] == "7157.83"
    assert visa["balance_as_of"]


def test_accounts_empty(client: TestClient) -> None:
    assert client.get("/api/accounts").json() == []


def test_sync_conflict_when_running(
    client: TestClient, mocked_simplefin: None, db: Session
) -> None:
    from app.config import get_settings
    from app.models.base import SyncTrigger
    from app.services import sync

    connect(client)
    sync.start_run(db, get_settings(), "simplefin", SyncTrigger.MANUAL)
    r = client.post("/api/sync")
    assert r.status_code == 409


def test_run_not_found(client: TestClient) -> None:
    assert client.get("/api/sync/runs/999999").status_code == 404
