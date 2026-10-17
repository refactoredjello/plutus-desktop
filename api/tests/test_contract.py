"""Guards on the API contract that every brief must keep true."""

import json
from pathlib import Path

from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from fastapi.routing import APIRoute
from sqlalchemy.orm import Session

from app.main import ROUTERS, app
from app.models import Base

SPEC_PATH = Path(__file__).parents[2] / "web" / "src" / "api" / "openapi.json"


def test_every_route_declares_a_response_model_or_204() -> None:
    # Walk the routers themselves: app.routes wraps included routers, which made this test
    # silently check nothing.
    routes = [r for router in ROUTERS for r in router.routes if isinstance(r, APIRoute)]
    assert len(routes) > 30
    for route in routes:
        assert route.response_model is not None or route.status_code == 204, route.path
        assert route.tags, f"{route.path} has no tag"


def test_operation_ids_are_unique() -> None:
    ids = [op["operationId"] for path in app.openapi()["paths"].values() for op in path.values()]
    assert len(ids) == len(set(ids))


def test_committed_openapi_spec_is_current() -> None:
    committed = json.loads(SPEC_PATH.read_text())
    assert committed == json.loads(json.dumps(app.openapi())), (
        "OpenAPI spec is stale. Run `make openapi` and commit the result."
    )


def test_models_match_migrations(db: Session) -> None:
    diff = compare_metadata(MigrationContext.configure(db.connection()), Base.metadata)
    assert diff == [], f"Models and migrations differ. Ask the orchestrator for a migration: {diff}"
