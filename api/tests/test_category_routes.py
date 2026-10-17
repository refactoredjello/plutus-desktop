from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import LLMProviderName, Settings, get_settings
from app.main import app
from app.models import Category, Rule
from app.models.base import Essentiality, RuleMatchType
from tests.factories import category_id


def test_list_categories_hides_hidden_by_default(client: TestClient, db: Session) -> None:
    all_cats = client.get("/api/categories").json()
    assert len(all_cats) >= 127
    assert {"id", "primary", "detailed", "label", "description", "is_hidden", "is_custom"} == set(
        all_cats[0]
    )
    coffee = category_id(db, "FOOD_AND_DRINK_COFFEE")
    assert client.patch(f"/api/categories/{coffee}", json={"is_hidden": True}).status_code == 200
    visible = {c["id"] for c in client.get("/api/categories").json()}
    assert coffee not in visible
    everything = {
        c["id"] for c in client.get("/api/categories", params={"include_hidden": "true"}).json()
    }
    assert coffee in everything


def test_create_custom_category(client: TestClient, db: Session) -> None:
    r = client.post(
        "/api/categories",
        json={
            "primary": "FOOD_AND_DRINK",
            "label": "Meal kits & boxes",
            "description": "Weekly boxes",
        },
    )
    assert r.status_code == 201
    body = r.json()
    assert body["detailed"] == "CUSTOM_MEAL_KITS_BOXES"
    assert (body["primary"], body["label"], body["is_custom"]) == (
        "FOOD_AND_DRINK",
        "Meal kits & boxes",
        True,
    )
    assert (
        db.scalars(select(Category).where(Category.detailed == "CUSTOM_MEAL_KITS_BOXES"))
        .one()
        .is_custom
    )

    duplicate = client.post(
        "/api/categories", json={"primary": "FOOD_AND_DRINK", "label": "meal kits boxes"}
    )
    assert duplicate.status_code == 409


def test_create_category_with_empty_slug_is_rejected(client: TestClient) -> None:
    assert (
        client.post("/api/categories", json={"primary": "OTHER", "label": "!!!"}).status_code == 400
    )


def test_update_category_label_and_404(client: TestClient, db: Session) -> None:
    cat = category_id(db, "FOOD_AND_DRINK_COFFEE")
    r = client.patch(f"/api/categories/{cat}", json={"label": "Cafes"})
    assert r.status_code == 200
    assert (r.json()["label"], r.json()["is_hidden"]) == ("Cafes", False)
    assert client.patch("/api/categories/999999", json={"label": "x"}).status_code == 404


def test_list_and_delete_rules(client: TestClient, db: Session) -> None:
    rule = Rule(
        match_type=RuleMatchType.PREFIX,
        pattern="UBER",
        category_id=category_id(db, "TRANSPORTATION_TAXIS_AND_RIDE_SHARES"),
        essentiality=Essentiality.FLEXIBLE,
    )
    db.add(rule)
    db.flush()
    rules = client.get("/api/rules").json()
    assert [(r["id"], r["match_type"], r["pattern"], r["essentiality"]) for r in rules] == [
        (rule.id, "prefix", "UBER", "flexible")
    ]
    assert client.delete(f"/api/rules/{rule.id}").status_code == 204
    assert client.get("/api/rules").json() == []
    assert client.delete(f"/api/rules/{rule.id}").status_code == 404


def _llm_status(client: TestClient, settings: Settings) -> dict[str, object]:
    app.dependency_overrides[get_settings] = lambda: settings
    return client.get("/api/settings/llm").json()


def test_llm_status(client: TestClient) -> None:
    fake = _llm_status(client, Settings(llm_provider=LLMProviderName.FAKE))
    assert fake == {"provider": "fake", "model": "claude-haiku-4-5", "configured": True}
    ollama = _llm_status(
        client, Settings(llm_provider=LLMProviderName.OLLAMA, llm_model="llama3.1")
    )
    assert ollama == {"provider": "ollama", "model": "llama3.1", "configured": True}
    no_key = _llm_status(
        client, Settings(llm_provider=LLMProviderName.CLAUDE, anthropic_api_key=None)
    )
    assert (no_key["provider"], no_key["configured"]) == ("claude", False)
    keyed = Settings(llm_provider=LLMProviderName.CLAUDE, anthropic_api_key="sk-test")  # type: ignore[arg-type]
    assert _llm_status(client, keyed)["configured"] is True
    assert "sk-test" not in str(_llm_status(client, keyed))
