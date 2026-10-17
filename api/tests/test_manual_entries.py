from datetime import date

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.factories import category_id, make_account, make_tx


def _body(**over: object) -> dict[str, object]:
    return {"amount": "-120.50", "description": "Car insurance", "due_date": "2026-11-01", **over}


def test_create_list_sorted_by_due_date(client: TestClient) -> None:
    client.post("/api/manual-entries", json=_body(description="Later", due_date="2026-12-01"))
    r = client.post("/api/manual-entries", json=_body(description="Sooner"))
    assert r.status_code == 201
    assert r.json()["amount"] == "-120.50"
    assert r.json()["recurrence"] == "none"
    rows = client.get("/api/manual-entries").json()
    assert [e["description"] for e in rows] == ["Sooner", "Later"]


def test_patch_only_sent_fields(client: TestClient, db: Session) -> None:
    cat = category_id(db, "FOOD_AND_DRINK_COFFEE")
    created = client.post("/api/manual-entries", json=_body(category_id=cat)).json()
    r = client.patch(f"/api/manual-entries/{created['id']}", json={"description": "Insurance"})
    assert r.status_code == 200
    assert r.json()["description"] == "Insurance"
    assert r.json()["category_id"] == cat
    assert r.json()["amount"] == "-120.50"
    r = client.patch(f"/api/manual-entries/{created['id']}", json={"category_id": None})
    assert r.json()["category_id"] is None


def test_patch_null_required_field_rejected(client: TestClient) -> None:
    created = client.post("/api/manual-entries", json=_body()).json()
    r = client.patch(f"/api/manual-entries/{created['id']}", json={"amount": None})
    assert r.status_code == 400


def test_delete(client: TestClient) -> None:
    created = client.post("/api/manual-entries", json=_body()).json()
    assert client.delete(f"/api/manual-entries/{created['id']}").status_code == 204
    assert client.get("/api/manual-entries").json() == []


def test_end_date_validation(client: TestClient) -> None:
    r = client.post("/api/manual-entries", json=_body(recurrence="monthly", end_date="2026-10-01"))
    assert r.status_code == 400
    r = client.post("/api/manual-entries", json=_body(end_date="2026-12-01"))
    assert r.status_code == 400
    ok = client.post("/api/manual-entries", json=_body(recurrence="monthly", end_date="2026-11-01"))
    assert ok.status_code == 201


def test_patch_validates_against_merged_state(client: TestClient) -> None:
    created = client.post(
        "/api/manual-entries", json=_body(recurrence="monthly", end_date="2027-01-01")
    ).json()
    url = f"/api/manual-entries/{created['id']}"
    assert client.patch(url, json={"recurrence": "none"}).status_code == 400
    assert client.patch(url, json={"due_date": "2027-02-01"}).status_code == 400
    assert client.patch(url, json={"recurrence": "none", "end_date": None}).status_code == 200


def test_unknown_references_rejected(client: TestClient, db: Session) -> None:
    assert client.post("/api/manual-entries", json=_body(category_id=999999)).status_code == 400
    created = client.post("/api/manual-entries", json=_body()).json()
    url = f"/api/manual-entries/{created['id']}"
    assert client.patch(url, json={"fulfilled_transaction_id": 999999}).status_code == 400
    tx = make_tx(db, make_account(db), "-120.50", posted_on=date(2026, 11, 1))
    r = client.patch(url, json={"fulfilled_transaction_id": tx.id})
    assert r.status_code == 200
    assert r.json()["fulfilled_transaction_id"] == tx.id


def test_missing_id_404(client: TestClient) -> None:
    assert client.patch("/api/manual-entries/999999", json={"description": "x"}).status_code == 404
    assert client.delete("/api/manual-entries/999999").status_code == 404
