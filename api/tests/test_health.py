from fastapi.testclient import TestClient


def test_health_reports_ok(client: TestClient) -> None:
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"
    assert res.json()["database"] == "ok"


def test_request_id_is_echoed(client: TestClient) -> None:
    res = client.get("/api/health", headers={"x-request-id": "abc123"})
    assert res.headers["x-request-id"] == "abc123"


def test_stubs_return_problem_details(client: TestClient) -> None:
    res = client.get("/api/goals")
    if res.status_code == 501:
        assert res.headers["content-type"] == "application/problem+json"
        assert res.json()["status"] == 501
